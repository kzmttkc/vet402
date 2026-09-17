// ============================================================
// レーン枠の同一ホスト上限（2026-09-18）。
//
// 本番実測（9/18 00:2x JST・Tempo）: 枠 5 件の先頭が stableenrich.dev の endpoint で埋まり、
// どれも `fee_payer_absent` で拒否（支出 0）——同じホストの 8 件で 2 バッチを消費した。
// 守ること: 1 レーンの枠の中で同じホストは最大 2 件、間引いたぶんは次のホストで埋める、
// クエリは枠の 8 倍（上限 200）を取る、並び順は保つ、レーンごとに数える。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANE_FLOOR_FETCH_MAX, LANE_FLOOR_MAX_PER_HOST, LANE_FLOOR_OVERSAMPLE } from "@/lib/observatory/budget";
import { laneFloorCandidates, laneHostOf } from "@/lib/observatory/l1-runner";

const row = (id: string, url: string) => ({ id, resource_url: url, method: "GET", price_amount: "1000", pay_to: "0x1", network: "eip155:4217", declared_schema: null, is_priority: false, is_mature: false });

test("one host cannot take more than two slots of a lane's floor; the rest is filled from the next hosts in order", async () => {
  const limits: number[] = [];
  const rows = [
    ...Array.from({ length: 8 }, (_, n) => row(`s${n}`, `https://stableenrich.dev/api/e${n}`)),
    row("a1", "https://aviationstack.mpp.tempo.xyz/v1/airports"),
    row("c1", "https://CoinGecko.mpp.paywithlocus.com/x"),
    row("c2", "https://coingecko.mpp.paywithlocus.com/y"),
    row("c3", "https://coingecko.mpp.paywithlocus.com/z"),
    row("f1", "https://fal.mpp.tempo.xyz/fal-ai/flux/dev"),
  ];
  const { head, counts, hostCapped } = await laneFloorCandidates({
    lanes: [{ chain: "tempo", ready: true }],
    floor: 5,
    fetchLane: async (_chain, limit) => {
      limits.push(limit);
      return rows;
    },
  });
  assert.deepEqual(limits, [5 * LANE_FLOOR_OVERSAMPLE], "the lane query oversamples so the cap can still fill the floor");
  assert.deepEqual(head.map((c) => c.id), ["s0", "s1", "a1", "c1", "c2"], "order kept; host compare is case-insensitive");
  assert.equal(counts.tempo, 5);
  assert.equal(hostCapped.tempo, 6, "six stableenrich rows were skipped before the floor filled (c3 and f1 were never reached)");
  assert.equal(LANE_FLOOR_MAX_PER_HOST, 2);
  assert.ok(head.every((c) => c.laneChain === "tempo"));
});

test("a lane with a single host yields at most two candidates; the cap is per lane, not across lanes; the fetch limit is capped", async () => {
  const limits: number[] = [];
  const { head, counts, hostCapped } = await laneFloorCandidates({
    lanes: [
      { chain: "tempo", ready: true },
      { chain: "arc", ready: true },
      { chain: "solana", ready: false },
    ],
    floor: 100,
    fetchLane: async (chain, limit) => {
      limits.push(limit);
      return chain === "tempo"
        ? Array.from({ length: 6 }, (_, n) => row(`t${n}`, `https://one-host.example/e${n}`))
        : Array.from({ length: 3 }, (_, n) => row(`a${n}`, `https://one-host.example/arc${n}`));
    },
  });
  assert.deepEqual(limits, [LANE_FLOOR_FETCH_MAX, LANE_FLOOR_FETCH_MAX]);
  assert.deepEqual(head.map((c) => c.id), ["t0", "t1", "a0", "a1"]);
  assert.deepEqual(counts, { tempo: 2, arc: 2, solana: 0 });
  assert.deepEqual(hostCapped, { tempo: 4, arc: 1, solana: 0 });
});

test("maxPerHost is injectable; an unparseable URL counts as its own host", async () => {
  const { head } = await laneFloorCandidates({
    lanes: [{ chain: "tempo", ready: true }],
    floor: 5,
    maxPerHost: 1,
    fetchLane: async () => [row("x1", "https://h.example/a"), row("x2", "https://h.example/b"), row("u1", "not a url"), row("u2", "also not a url")],
  });
  assert.deepEqual(head.map((c) => c.id), ["x1", "u1", "u2"]);
  assert.equal(laneHostOf("https://Fal.MPP.tempo.xyz/x?y=1"), "fal.mpp.tempo.xyz");
});
