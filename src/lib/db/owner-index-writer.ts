import { and, eq, sql } from "drizzle-orm";
import type { Address } from "viem";
import { getDb } from "./client";
import { ownerAgents } from "./schema";
import { DeadlineExceededError } from "@/lib/util/deadline";

/** Trusted indexer write path — never called from live API scoring. */
export async function upsertOwnerAgent(owner: Address, agentId: bigint): Promise<void> {
  const db = getDb();
  if (!db) return;

  const ownerKey = owner.toLowerCase();
  await db
    .insert(ownerAgents)
    .values({ owner: ownerKey, agentId })
    .onConflictDoUpdate({
      target: [ownerAgents.owner, ownerAgents.agentId],
      set: { updatedAt: new Date() },
    });
}

export async function removeOwnerAgent(owner: Address, agentId: bigint): Promise<void> {
  const db = getDb();
  if (!db) return;

  await db
    .delete(ownerAgents)
    .where(
      and(
        eq(ownerAgents.owner, owner.toLowerCase()),
        eq(ownerAgents.agentId, agentId),
      ),
    );
}

export async function removeAgentFromIndex(agentId: bigint): Promise<void> {
  const db = getDb();
  if (!db) return;

  await db.delete(ownerAgents).where(eq(ownerAgents.agentId, agentId));
}

/**
 * 区切り 1 つぶんの所有者索引の変更（2026-10-31）。owner-indexer が区切りの全イベントを
 * 1 件ずつ書いていた手順（upsert / removeOwnerAgent / removeAgentFromIndex を順に）を、
 * agentId ごとの「最後に残る形」に畳んだもの。
 *
 *  - upserts:     残す (owner, agentId)
 *  - deletePairs: 消す (owner, agentId)（wipe しない agentId のものだけ）
 *  - wipe:        行を全部消してから upserts の分だけ残す agentId
 *
 * 1 つの agentId について、同じ owner が upserts と deletePairs の両方に入ることはない。
 */
export type OwnerAgentChanges = {
  upserts: { owner: Address; agentId: bigint }[];
  deletePairs: { owner: Address; agentId: bigint }[];
  wipe: bigint[];
};

/**
 * 1 文あたりの行数と、同時に投げる文の数。
 *
 * 10 月の Base には 20,000 ブロックに Transfer が 28〜44 万件ある所がある（10/31 実測）。
 * 1 件ずつ 2〜3 文（Neon HTTP の 1 往復 150〜300ms）では、1 区切りが何時間もかかる。
 * 1,000 行ずつにまとめ、4 本並べて投げる（upsert の段 → delete の段の 2 段。applyOwnerAgentChanges）。
 * 最も濃い区切り（手元の実測で 18.5 万 agentId）で upsert 185 文 + delete 185 文 = 4 本並列で 94 往復。
 * 手元の Postgres で 5.7〜8.0 秒（10/31 実測）。segmented-scan.ts は読み終えてから書き込みの期限まで
 * 70 秒を残すので、その 8.7 倍・1 往復 0.74 秒まで耐える。超えた区切りは checkpoint を進めずに止まる。
 * 1 文の引数は最大 3,000 個（Postgres の上限は 65,535）。
 */
const OWNER_WRITE_BATCH = 1_000;
const OWNER_WRITE_CONCURRENCY = 4;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function pairList(pairs: readonly { owner: Address; agentId: bigint }[]) {
  return sql.join(
    pairs.map((p) => sql`(${p.owner.toLowerCase()}, ${p.agentId.toString()}::bigint)`),
    sql`, `,
  );
}

/** 複数行の upsert（1 文 = 最大 OWNER_WRITE_BATCH 行）。同じ組が 2 回入っていてもよい（ここで 1 つに畳む）。 */
export async function upsertOwnerAgents(pairs: readonly { owner: Address; agentId: bigint }[]): Promise<void> {
  const db = getDb();
  if (!db || pairs.length === 0) return;
  const unique = new Map<string, { owner: string; agentId: bigint }>();
  for (const p of pairs) unique.set(`${p.owner.toLowerCase()}:${p.agentId}`, { owner: p.owner.toLowerCase(), agentId: p.agentId });
  for (const batch of chunk([...unique.values()], OWNER_WRITE_BATCH)) {
    await db
      .insert(ownerAgents)
      .values(batch)
      .onConflictDoUpdate({
        target: [ownerAgents.owner, ownerAgents.agentId],
        set: { updatedAt: new Date() },
      });
  }
}

/** (owner, agentId) の組を消す。 */
export async function deleteOwnerAgentPairs(pairs: readonly { owner: Address; agentId: bigint }[]): Promise<void> {
  const db = getDb();
  if (!db || pairs.length === 0) return;
  for (const batch of chunk(pairs, OWNER_WRITE_BATCH)) {
    await db.delete(ownerAgents).where(sql`(${ownerAgents.owner}, ${ownerAgents.agentId}) IN (${pairList(batch)})`);
  }
}

/** agentIds の行を、keep に挙げた組を除いて全部消す。 */
export async function removeAgentsFromIndexExcept(
  agentIds: readonly bigint[],
  keep: readonly { owner: Address; agentId: bigint }[],
): Promise<void> {
  const db = getDb();
  if (!db || agentIds.length === 0) return;
  const ids = sql.join(agentIds.map((id) => sql`${id.toString()}::bigint`), sql`, `);
  const where =
    keep.length === 0
      ? sql`${ownerAgents.agentId} IN (${ids})`
      : sql`${ownerAgents.agentId} IN (${ids}) AND (${ownerAgents.owner}, ${ownerAgents.agentId}) NOT IN (${pairList(keep)})`;
  await db.delete(ownerAgents).where(where);
}

/** 書き込みを途中でやめるための合図（2026-10-31 レビュー L-1）。 */
export type OwnerWriteOptions = {
  /** true を返したら、次の文を始めずに DeadlineExceededError を投げる（走っている文は待つ）。 */
  shouldStop?: () => boolean;
};

/**
 * 束を最大 OWNER_WRITE_CONCURRENCY 本ずつ並べて流す。1 本でも落ちたら、残りの束を始めずに、
 * 走っている束が終わるのを待ってから最初の失敗を投げる（投げた後に書き込みが続かないように）。
 */
async function runTasks(tasks: (() => Promise<void>)[], options: OwnerWriteOptions | undefined): Promise<void> {
  let next = 0;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(OWNER_WRITE_CONCURRENCY, tasks.length) }, async () => {
      while (firstError === undefined && next < tasks.length) {
        if (options?.shouldStop?.()) {
          firstError ??= new DeadlineExceededError("owner-index-writer", 0);
          break;
        }
        const task = tasks[next++]!;
        try {
          await task();
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError !== undefined) throw firstError;
}

/**
 * 区切り 1 つぶんの変更を書く。neon-http では transaction が使えないので、途中で落ちうる。
 * 落ちても次の回が同じ区切りを読み直して同じ変更を作り直す（どの文も何度書いても同じ結果）。
 *
 * 順序は 2 段: **残す行の upsert を全部書き終えてから、消す文を始める**。upsert が 1 本でも落ちたら、
 * 消す文は 1 つも走らない（2026-10-31 レビュー M-1: 初版は upsert の束と delete の束を同じ並びで
 * 並べていたので、別の束の upsert が落ちても delete は走り、agent の行が 0 本になる形を実 DB で再現された）。
 *
 * 途中で落ちたときに残るのは「古い候補が余分にある」側の誤りだけにする。owner_agents は
 * wallet→agent 解決の候補でしかなく、確定はオンチェーンの束縛照合がするので、余分な候補は
 * resolver の答えを変えない。countAgentsByOwner（所有者が持つエージェントの数）は余分な行の分だけ
 * 多く数えるが、これは所有数を水増しする向き＝採点では慎重な側に倒れる。逆（先に消す）だと、落ちてから
 * 次の回までの間、実在のエージェントが候補から消える（素のウォレットとして採点される＝fail-open 側）。
 */
export async function applyOwnerAgentChanges(changes: OwnerAgentChanges, options?: OwnerWriteOptions): Promise<void> {
  const db = getDb();
  if (!db) return;

  const wipeSet = new Set(changes.wipe.map((id) => id.toString()));
  const keepById = new Map<string, { owner: Address; agentId: bigint }[]>();
  for (const p of changes.upserts) {
    if (!wipeSet.has(p.agentId.toString())) continue;
    const key = p.agentId.toString();
    keepById.set(key, [...(keepById.get(key) ?? []), p]);
  }
  const wipeIds = [...wipeSet].map((id) => BigInt(id));

  // 1 段目: 残す行を全部（wipe しない agentId の分も、wipe する agentId に残す分も）。
  await runTasks(
    chunk(changes.upserts, OWNER_WRITE_BATCH).map((batch) => () => upsertOwnerAgents(batch)),
    options,
  );

  // 2 段目: 消す。1 段目が全部通ったときだけここに来る。
  await runTasks(
    [
      ...chunk(changes.deletePairs, OWNER_WRITE_BATCH).map((batch) => () => deleteOwnerAgentPairs(batch)),
      ...chunk(wipeIds, OWNER_WRITE_BATCH).map((ids) => () =>
        removeAgentsFromIndexExcept(ids, ids.flatMap((id) => keepById.get(id.toString()) ?? [])),
      ),
    ],
    options,
  );
}
