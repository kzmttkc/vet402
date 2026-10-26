// ============================================================
// レーン枠の取得を並べて走らせ、枠を交互に並べる（2026-10-27）。
//
// 本番の実測（読み取り）: 準備の中で、レーンごとの候補の取得（laneFloorCandidates → fetchLane → targetsSql）を
// レーン 10 本ぶん 1 本ずつ順に待っていた。並びは「solana の 5 件 → arc の 5 件 → …」で、時間の上限
// （L1_LANE_TIME_SHARE）で後ろが切られると、後ろのレーン（Avalanche・Stellar）は 1 件も試せなかった。
//
// 守ること:
//  1. 取得は全レーン同時に始まる（1 本目が返るのを待たずに 2 本目が始まる）。
//  2. 取得が返る順がばらばらでも、counts・hostCapped・各レーンの中の並び・重複排除は、順に取得していたときと同じ。
//  3. 並びは「各レーンの 1 件目をレーンの順に → 各レーンの 2 件目を → …」。
//  4. 失敗したレーンは 0 件（ログに残す）。他のレーンはそのまま。
//  5. 問い合わせたレーンごとの取得時間（fetchMs）を返す。問い合わせなかったレーンは載せない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANE_FLOOR_FETCH_MAX, LANE_FLOOR_MAX_PER_HOST, LANE_FLOOR_OVERSAMPLE, type CappedChain } from "@/lib/observatory/budget";
import { interleaveLanes, laneFloorCandidates, laneHostOf } from "@/lib/observatory/l1-runner";

const row = (id: string, url: string) => ({ id, resource_url: url, method: "GET", price_amount: "1000", pay_to: "0x1", network: "eip155:8453", declared_schema: null, is_priority: false, is_mature: false });

/** 2026-10-27 より前の laneFloorCandidates（レーンを 1 本ずつ順に取得し、レーンごとにまとめて並べる）の写し。比べる相手。 */
async function sequentialReference(input: {
  lanes: readonly { chain: CappedChain; ready: boolean }[];
  floor: number;
  fetchLane: (chain: CappedChain, limit: number) => Promise<unknown>;
}) {
  const head: { id: string; laneChain: CappedChain }[] = [];
  const counts: Partial<Record<CappedChain, number>> = {};
  const hostCapped: Partial<Record<CappedChain, number>> = {};
  const seen = new Set<string>();
  for (const lane of input.lanes) {
    counts[lane.chain] = 0;
    hostCapped[lane.chain] = 0;
    if (!lane.ready || input.floor <= 0) continue;
    let rows: Record<string, unknown>[] = [];
    try {
      rows = (await input.fetchLane(lane.chain, Math.min(input.floor * LANE_FLOOR_OVERSAMPLE, LANE_FLOOR_FETCH_MAX))) as Record<string, unknown>[];
    } catch {
      continue;
    }
    const perHost = new Map<string, number>();
    for (const r of rows) {
      if ((counts[lane.chain] ?? 0) >= input.floor) break;
      const id = String(r.id);
      if (seen.has(id)) continue;
      const host = laneHostOf(String(r.resource_url));
      const used = perHost.get(host) ?? 0;
      if (used >= LANE_FLOOR_MAX_PER_HOST) {
        hostCapped[lane.chain] = (hostCapped[lane.chain] ?? 0) + 1;
        continue;
      }
      perHost.set(host, used + 1);
      seen.add(id);
      head.push({ id, laneChain: lane.chain });
      counts[lane.chain] = (counts[lane.chain] ?? 0) + 1;
    }
  }
  return { head, counts, hostCapped };
}

const LANES = [
  { chain: "solana", ready: true },
  { chain: "arc", ready: true },
  { chain: "arc_gateway", ready: false },
  { chain: "tempo", ready: true },
  { chain: "xrpl", ready: true },
  { chain: "celo", ready: true },
  { chain: "bnb", ready: true },
  { chain: "arbitrum", ready: true },
  { chain: "avalanche", ready: true },
  { chain: "stellar", ready: true },
] as const satisfies readonly { chain: CappedChain; ready: boolean }[];

/** レーンごとの行。同じホストの出品・レーンをまたいだ同じ id（Base 先頭で 2 つのチェーンの accept を持つ行）を混ぜる。 */
function rowsFor(chain: CappedChain): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const size = chain === "xrpl" ? 2 : chain === "stellar" ? 9 : 7;
  for (let i = 0; i < size; i++) out.push(row(`${chain}-${i}`, `https://${chain}-h${i % 3}.example/e${i}`));
  if (chain === "arc" || chain === "celo" || chain === "avalanche") out.splice(1, 0, row("shared-1", "https://shared.example/x"));
  if (chain === "bnb" || chain === "arbitrum") out.unshift(row("shared-2", "https://shared2.example/y"));
  return out;
}

test("取得は全レーン同時に始まる（1 本目が返るまで 2 本目を待たない）", async () => {
  const ready = LANES.filter((l) => l.ready).length;
  let started = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((r) => (release = r));
  const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("not parallel")), ms));
  const out = await laneFloorCandidates({
    lanes: LANES,
    floor: 5,
    fetchLane: async (chain) => {
      started++;
      if (started === ready) release();
      // 全レーンが始まるまで返さない。順に待つ実装なら 1 本目がここで止まり、500ms で失敗する。
      await Promise.race([allStarted, timeout(500)]);
      return rowsFor(chain);
    },
  });
  assert.equal(started, ready);
  for (const lane of LANES) if (lane.ready) assert.ok((out.counts[lane.chain] ?? 0) > 0, `${lane.chain} が 0 件（並べて走っていない）`);
});

test("返る順がばらばらでも、counts・hostCapped・各レーンの中の並び・重複排除は、順に取得したときと同じ", async () => {
  const delays: Partial<Record<CappedChain, number>> = { solana: 40, arc: 5, tempo: 30, xrpl: 1, celo: 25, bnb: 10, arbitrum: 35, avalanche: 2, stellar: 15 };
  const parallel = await laneFloorCandidates({
    lanes: LANES,
    floor: 5,
    fetchLane: async (chain) => {
      await new Promise((r) => setTimeout(r, delays[chain] ?? 0));
      return rowsFor(chain);
    },
  });
  const ref = await sequentialReference({ lanes: LANES, floor: 5, fetchLane: async (chain) => rowsFor(chain) });
  assert.deepEqual(parallel.counts, ref.counts);
  assert.deepEqual(parallel.hostCapped, ref.hostCapped);
  // 同じ集合・同じレーンの割り当て（交互の並び以外は同じ）。
  const byLane = (list: { id: string; laneChain: CappedChain | null }[]) => {
    const m = new Map<string, string[]>();
    for (const c of list) m.set(String(c.laneChain), [...(m.get(String(c.laneChain)) ?? []), c.id]);
    return Object.fromEntries(m);
  };
  assert.deepEqual(byLane(parallel.head), byLane(ref.head), "各レーンの中の並びと、どのレーンが取ったかは同じ");
  assert.equal(new Set(parallel.head.map((c) => c.id)).size, parallel.head.length, "同じ id を 2 度入れない");
  // shared-1 は先に回る arc が取り、celo・avalanche は取らない（レーンの順の重複排除。返った順ではない）。
  assert.equal(parallel.head.find((c) => c.id === "shared-1")?.laneChain, "arc");
  assert.equal(parallel.head.find((c) => c.id === "shared-2")?.laneChain, "bnb");
  // 並びは、順に取った各レーンの列を交互にしたもの。
  const refLists = LANES.filter((l) => l.ready).map((l) => ref.head.filter((c) => c.laneChain === l.chain).map((c) => c.id));
  assert.deepEqual(parallel.head.map((c) => c.id), interleaveLanes(refLists));
});

test("並びは各レーンの 1 件目をレーンの順に → 2 件目を順に → …（後ろを切られてもどのレーンも 1 件目は前にある）", async () => {
  const out = await laneFloorCandidates({
    lanes: [
      { chain: "solana", ready: true },
      { chain: "arc", ready: true },
      { chain: "xrpl", ready: true },
      { chain: "avalanche", ready: true },
    ],
    floor: 3,
    fetchLane: async (chain) =>
      chain === "xrpl"
        ? [row("xrpl-0", "https://x.example/0")]
        : Array.from({ length: 3 }, (_, i) => row(`${chain}-${i}`, `https://${chain}-${i}.example/e`)),
  });
  assert.deepEqual(out.head.map((c) => c.id), [
    "solana-0", "arc-0", "xrpl-0", "avalanche-0",
    "solana-1", "arc-1", "avalanche-1",
    "solana-2", "arc-2", "avalanche-2",
  ]);
  assert.ok(out.head.every((c) => c.id.startsWith(`${c.laneChain}-`)), "候補のレーンは取ったレーンのまま");
  assert.deepEqual(out.head.slice(0, 4).map((c) => c.laneChain), ["solana", "arc", "xrpl", "avalanche"], "先頭の 4 件で全レーンの 1 件目");
  assert.deepEqual(out.counts, { solana: 3, arc: 3, xrpl: 1, avalanche: 3 });
  assert.deepEqual(interleaveLanes([[1, 2, 3], [], [4], [5, 6]]), [1, 4, 5, 2, 6, 3]);
  assert.deepEqual(interleaveLanes([]), []);
});

test("失敗したレーンは 0 件（ログに残す）。他のレーンの件数と並びはそのまま", async () => {
  const logged: string[] = [];
  const orig = { error: console.error, warn: console.warn };
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    const out = await laneFloorCandidates({
      lanes: [
        { chain: "solana", ready: true },
        { chain: "arc", ready: true },
        { chain: "tempo", ready: true },
      ],
      floor: 2,
      fetchLane: async (chain) => {
        if (chain === "arc") throw new Error("boom");
        return [row(`${chain}-0`, `https://${chain}-a.example/0`), row(`${chain}-1`, `https://${chain}-b.example/1`)];
      },
    });
    assert.deepEqual(out.counts, { solana: 2, arc: 0, tempo: 2 });
    assert.deepEqual(out.hostCapped, { solana: 0, arc: 0, tempo: 0 });
    assert.deepEqual(out.head.map((c) => c.id), ["solana-0", "tempo-0", "solana-1", "tempo-1"]);
    assert.ok(logged.some((l) => l.includes("observatory.l1.lane_floor_arc")), `ログ: ${JSON.stringify(logged)}`);
    assert.ok("arc" in out.fetchMs, "失敗したレーンも取得の時間は載せる");
  } finally {
    console.error = orig.error;
    console.warn = orig.warn;
  }
});

test("fetchMs は問い合わせたレーンだけ。時計は差し替えられる", async () => {
  let t = 1_000;
  const out = await laneFloorCandidates({
    lanes: [
      { chain: "solana", ready: true },
      { chain: "arc", ready: false },
      { chain: "tempo", ready: true },
    ],
    floor: 1,
    now: () => (t += 250),
    fetchLane: async (chain) => [row(`${chain}-0`, `https://${chain}.example/0`)],
  });
  assert.deepEqual(Object.keys(out.fetchMs).sort(), ["solana", "tempo"]);
  for (const v of Object.values(out.fetchMs)) assert.ok(typeof v === "number" && v >= 0);
  const none = await laneFloorCandidates({ lanes: [{ chain: "solana", ready: true }], floor: 0, fetchLane: async () => [] });
  assert.deepEqual(none.fetchMs, {}, "枠 0 では問い合わせない");
});
