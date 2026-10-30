// ============================================================
// vet402 — 所有者索引の「区切りの変更を畳んでまとめて書く」は、以前の「1 件ずつ順に書く」と
// 同じ最終形になる（2026-10-31）。
//
// 10/31 から owner-indexer は、区切りの Registered / Transfer を 1 件ずつ DB に書く代わりに
// ownerChangesForSegment で agentId ごとの最後の形に畳み、applyOwnerAgentChanges が
// 「残す行を先に upsert → 消す組を delete → wipe した agentId の残りを delete」の順で書く。
// ここでは、以前の手順（10/30 までの owner-indexer.ts の本文をそのまま写したもの）と、畳んだ変更を
// 同じ書き方で当てたものを、乱数で作った履歴と元の行の組み合わせで突き合わせる。DB も RPC も使わない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { ownerChangesForSegment } from "@/lib/indexer/owner-indexer";
import type { OwnerAgentChanges } from "@/lib/db/owner-index-writer";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ADDRS = ["a", "b", "c", "d"].map((c) => `0x${c.repeat(40)}` as Address);
type Lookup = Address | null | "unavailable";

/** 決まった種から作る乱数（再現できるように）。 */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const key = (owner: string, id: bigint) => `${owner.toLowerCase()}:${id}`;

/** 10/30 までの owner-indexer.ts の書き方そのもの（DB の代わりに Set）。 */
function sequential(
  rows: Set<string>,
  registered: { args: { agentId?: bigint; owner?: Address } }[],
  transfers: { args: { tokenId?: bigint; from?: Address; to?: Address }; blockNumber: bigint; logIndex: number }[],
  owners: Map<string, Lookup>,
) {
  const upsert = (owner: Address, id: bigint) => rows.add(key(owner, id));
  const removePair = (owner: Address, id: bigint) => rows.delete(key(owner, id));
  const removeAgent = (id: bigint) => {
    for (const r of [...rows]) if (r.endsWith(`:${id}`)) rows.delete(r);
  };
  for (const { args } of registered) {
    const { agentId, owner } = args;
    if (agentId === undefined || !owner) continue;
    const current = owners.get(agentId.toString());
    if (current === "unavailable") upsert(owner, agentId);
    else if (current && current.toLowerCase() === owner.toLowerCase()) upsert(owner, agentId);
  }
  const ordered = [...transfers].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  for (const { args } of ordered) {
    const { tokenId: id, from, to } = args;
    if (id === undefined) continue;
    if (from && from !== ZERO) removePair(from, id);
    if (to && to !== ZERO) {
      const verified = owners.get(id.toString());
      if (verified === "unavailable") upsert(to, id);
      else if (verified && verified.toLowerCase() === to.toLowerCase()) {
        removeAgent(id);
        upsert(to, id);
      } else if (verified === null) removeAgent(id);
      else if (verified) {
        removeAgent(id);
        upsert(verified, id);
      }
    } else removeAgent(id);
  }
}

/** applyOwnerAgentChanges と同じ意味の当て方（DB の代わりに Set）。 */
function applyFolded(rows: Set<string>, changes: OwnerAgentChanges) {
  const keepById = new Map<string, Set<string>>();
  for (const p of changes.upserts) {
    rows.add(key(p.owner, p.agentId));
    const k = p.agentId.toString();
    keepById.set(k, (keepById.get(k) ?? new Set()).add(key(p.owner, p.agentId)));
  }
  for (const p of changes.deletePairs) rows.delete(key(p.owner, p.agentId));
  for (const id of changes.wipe) {
    const keep = keepById.get(id.toString()) ?? new Set();
    for (const r of [...rows]) if (r.endsWith(`:${id}`) && !keep.has(r)) rows.delete(r);
  }
}

test("folded segment changes leave exactly the rows the old one-by-one writes left (2,000 random histories)", () => {
  const rand = rng(20261031);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  for (let round = 0; round < 2_000; round++) {
    const ids = [1n, 2n, 3n];
    const prior = new Set<string>();
    for (const id of ids) for (const a of ADDRS) if (rand() < 0.25) prior.add(key(a, id));

    const owners = new Map<string, Lookup>();
    for (const id of ids) owners.set(id.toString(), pick<Lookup>([...ADDRS, null, "unavailable"]));

    const registered = Array.from({ length: Math.floor(rand() * 3) }, () => ({
      args: { agentId: pick(ids), owner: pick(ADDRS) },
    }));
    const transfers = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => ({
      args: { tokenId: pick(ids), from: pick([ZERO, ...ADDRS]), to: pick([ZERO, ...ADDRS]) },
      blockNumber: BigInt(Math.floor(rand() * 4)),
      logIndex: i,
    }));

    const expected = new Set(prior);
    sequential(expected, registered, transfers, owners);

    const actual = new Set(prior);
    const { changes } = ownerChangesForSegment(registered, transfers, owners);
    applyFolded(actual, changes);

    assert.deepEqual([...actual].sort(), [...expected].sort(), `round ${round}`);

    // 1 つの agentId で、同じ owner が「残す」と「消す」の両方に入らない（書く順を入れ替えても同じ結果）。
    const upsertKeys = new Set(changes.upserts.map((p) => key(p.owner, p.agentId)));
    for (const p of changes.deletePairs) assert.ok(!upsertKeys.has(key(p.owner, p.agentId)), `round ${round}`);
  }
});

test("the upserted / removed counts are the same per-step counts as before", () => {
  const A = ADDRS[0]!;
  const B = ADDRS[1]!;
  const owners = new Map<string, Lookup>([["1", B]]);
  const { upserted, removed, changes } = ownerChangesForSegment(
    [{ args: { agentId: 1n, owner: A } }],
    [
      { args: { tokenId: 1n, from: ZERO, to: A }, blockNumber: 1n, logIndex: 0 },
      { args: { tokenId: 1n, from: A, to: B }, blockNumber: 2n, logIndex: 0 },
    ],
    owners,
  );
  // Registered(A) は ownerOf=B と食い違うので数えない。mint 0→A は「ownerOf を信じて B を書く」で 1、
  // A→B は from の削除で removed 1・to=B で upserted 1。
  assert.equal(upserted, 2);
  assert.equal(removed, 1);
  assert.deepEqual(changes.wipe, [1n]);
  assert.deepEqual(changes.upserts.map((p) => key(p.owner, p.agentId)), [key(B, 1n)]);
  assert.deepEqual(changes.deletePairs, []);
});
