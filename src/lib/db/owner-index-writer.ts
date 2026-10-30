import { and, eq, sql } from "drizzle-orm";
import type { Address } from "viem";
import { getDb } from "./client";
import { ownerAgents } from "./schema";

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
 * 1,000 行ずつにまとめ、agentId の重ならない束を 4 本並べて投げる。最も濃い区切り（手元の実測で
 * 18.5 万 agentId）でも 370 文 ÷ 4 本 ≒ 93 往復 ≒ 30 秒弱に収まり、segmented-scan.ts が
 * 読み終えた後に残す 70 秒の中で書き終わる。1 文の引数は最大 3,000 個（Postgres の上限は 65,535）。
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

/**
 * 区切り 1 つぶんの変更を書く。neon-http では transaction が使えないので、途中で落ちうる。
 * 落ちても次の回が同じ区切りを読み直して同じ変更を作り直す（どの文も何度書いても同じ結果）。
 *
 * 順序: **残す行を先に書き、消すのは後**。途中で落ちたとき、残るのは「古い候補が余分にある」
 * 側の誤りだけにする。owner_agents は wallet→agent 解決の候補でしかなく、確定はオンチェーンの
 * 束縛照合がするので、余分な候補は答えを変えない。逆（先に消す）だと、落ちてから次の回までの間、
 * 実在のエージェントが候補から消える（素のウォレットとして採点される＝fail-open 側）。
 */
export async function applyOwnerAgentChanges(changes: OwnerAgentChanges): Promise<void> {
  const db = getDb();
  if (!db) return;

  const wipeSet = new Set(changes.wipe.map((id) => id.toString()));
  // agentId の重ならない束に分ける。束の中は「upsert → wipe の delete」の順を守り、束どうしは並べてよい。
  const byId = new Map<string, { upserts: { owner: Address; agentId: bigint }[] }>();
  for (const p of changes.upserts) {
    const key = p.agentId.toString();
    const entry = byId.get(key) ?? { upserts: [] };
    entry.upserts.push(p);
    byId.set(key, entry);
  }
  const upsertOnly = changes.upserts.filter((p) => !wipeSet.has(p.agentId.toString()));
  const wipeIds = [...wipeSet].map((id) => BigInt(id));

  const tasks: (() => Promise<void>)[] = [];
  for (const batch of chunk(upsertOnly, OWNER_WRITE_BATCH)) tasks.push(() => upsertOwnerAgents(batch));
  for (const batch of chunk(changes.deletePairs, OWNER_WRITE_BATCH)) tasks.push(() => deleteOwnerAgentPairs(batch));
  for (const ids of chunk(wipeIds, OWNER_WRITE_BATCH)) {
    tasks.push(async () => {
      const keep = ids.flatMap((id) => byId.get(id.toString())?.upserts ?? []);
      await upsertOwnerAgents(keep);
      await removeAgentsFromIndexExcept(ids, keep);
    });
  }

  // 1 本が落ちたら、ほかの本も次の文を始めない（呼び手が throw を受けた後に書き込みが続かないように）。
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(OWNER_WRITE_CONCURRENCY, tasks.length) }, async () => {
      while (!failed && next < tasks.length) {
        try {
          await tasks[next++]!();
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
}
