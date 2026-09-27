// ============================================================
// 売り手の census（全員 1 回ずつ）レーン（2026-09-28）— 選び方の純関数と旗。
//
// Base の公開カタログの売り手（ホスト）のうち、L1 の購入行がまだ 1 件も無いホストを、そのホストの
// いちばん安い出品（1 回 $1 以下）で 1 回ずつ、レーン枠の後ろ・主候補の前に置く。
// SQL（censusTargetsSql）が 1 ホスト 1 件・安い順を選び、pickCensusRows が金の経路へ渡す前に
// 同じ規則を掛け直す。ここは DB 無しで後者を固定する。SQL と購入の挙動は l1-census.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { CENSUS_PER_RUN, isCensusEnabled } from "@/lib/observatory/budget";
import { censusCandidates, censusHostOf, pickCensusRows } from "@/lib/observatory/l1-runner";

const row = (id: string, host: string, price: string, extra: Record<string, unknown> = {}) => ({
  id,
  resource_url: `https://${host}/api/${id}`,
  method: "GET",
  price_amount: price,
  pay_to: "0x1111111111111111111111111111111111111111",
  network: "eip155:8453",
  declared_schema: null,
  is_priority: false,
  is_mature: false,
  settled_networks: [],
  failed_networks: [],
  xrpl_declared_pay_tos: [],
  arc_declared_accepts: [],
  census_price: price,
  census_host: host,
  ...extra,
});

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test("旗は OBSERVATORY_L1_CENSUS が正確に \"on\" のときだけ（既定 OFF）・1 バッチの上限は 40", () => {
  assert.equal(CENSUS_PER_RUN, 40);
  withEnv("OBSERVATORY_L1_CENSUS", undefined, () => assert.equal(isCensusEnabled(), false));
  for (const v of ["", "true", "ON", "1", "yes", " on"]) {
    withEnv("OBSERVATORY_L1_CENSUS", v, () => assert.equal(isCensusEnabled(), false, `value ${JSON.stringify(v)}`));
  }
  withEnv("OBSERVATORY_L1_CENSUS", "on", () => assert.equal(isCensusEnabled(), true));
});

test("1 ホスト 1 件・そのホストのいちばん安い出品を選ぶ（同額なら id の小さい方）", () => {
  const out = pickCensusRows(
    [
      row("c", "a.example", "5000"),
      row("b", "a.example", "2000"),
      row("a", "a.example", "2000"),
      row("z", "b.example", "3000"),
    ],
    40,
  );
  assert.deepEqual(
    out.map((c) => c.id),
    ["a", "z"],
    "a.example は 2000 の 2 件のうち id の小さい a、b.example は 1 件",
  );
  assert.ok(out.every((c) => c.selection === "census"));
  assert.ok(out.every((c) => c.laneChain === null), "census はレーンの accept 優先を持たない");
});

test("並びは安い順（同額ならホスト名順）・perRun 件で切る", () => {
  const out = pickCensusRows(
    [row("1", "c.example", "3000"), row("2", "b.example", "1000"), row("3", "a.example", "3000"), row("4", "d.example", "999")],
    3,
  );
  assert.deepEqual(out.map((c) => c.id), ["4", "2", "3"]);
});

test("$1（1,000,000 単位）を超える出品・0・読めない額は選ばない", () => {
  const out = pickCensusRows(
    [
      row("over", "over.example", "1000001"),
      row("edge", "edge.example", "1000000"),
      row("zero", "zero.example", "0"),
      row("neg", "neg.example", "-5"),
      row("frac", "frac.example", "0.5"),
      row("junk", "junk.example", "abc"),
      row("null", "null.example", "1", { census_price: null }),
      row("numtext", "numtext.example", "1500.000"),
    ],
    40,
  );
  assert.deepEqual(out.map((c) => c.id).sort(), ["edge", "numtext"]);
});

test("ホストの安い方が $1 超なら、同じホストの $1 以下の出品が選ばれる（上限超を 1 件目に数えない）", () => {
  const out = pickCensusRows([row("x", "h.example", "2000000"), row("y", "h.example", "900000")], 40);
  assert.deepEqual(out.map((c) => c.id), ["y"]);
});

test("レーン枠に既に入った行（excludeIds）は入れない——レーン枠を削らない", () => {
  const out = pickCensusRows([row("lane", "a.example", "1000"), row("other", "b.example", "2000")], 40, new Set(["lane"]));
  assert.deepEqual(out.map((c) => c.id), ["other"]);
});

test("旗が off なら問い合わせもしない（空）", async () => {
  let called = 0;
  const out = await censusCandidates({
    enabled: false,
    perRun: 40,
    excludeIds: new Set(),
    fetchCensus: async () => {
      called++;
      return [row("a", "a.example", "1000")];
    },
  });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test("旗が on なら perRun + 除外ぶんを取り、問い合わせの失敗はバッチを止めない（0 件）", async () => {
  let asked = -1;
  const out = await censusCandidates({
    enabled: true,
    perRun: 2,
    excludeIds: new Set(["x"]),
    fetchCensus: async (limit) => {
      asked = limit;
      return { rows: [row("x", "x.example", "1"), row("a", "a.example", "1000"), row("b", "b.example", "2000"), row("c", "c.example", "3000")] };
    },
  });
  assert.equal(asked, 3);
  assert.deepEqual(out.map((c) => c.id), ["a", "b"]);

  const failed = await censusCandidates({
    enabled: true,
    perRun: 2,
    excludeIds: new Set(),
    fetchCensus: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(failed, []);
});

test("ポート違いは 1 売り手（独立レビュー 2026-09-28: api.verigrace.com:4449/4450/4451 が 3 回買われるところだった）", () => {
  assert.equal(censusHostOf("API.Verigrace.com:4449"), "api.verigrace.com");
  assert.equal(censusHostOf("api.verigrace.com"), "api.verigrace.com");
  const out = pickCensusRows(
    [
      row("p1", "api.verigrace.com:4449", "3000"),
      row("p2", "api.verigrace.com:4450", "2000"),
      row("p3", "api.verigrace.com:4451", "2000"),
      row("q", "other.example", "5000"),
    ],
    40,
  );
  assert.deepEqual(out.map((c) => c.id), ["p2", "q"], "verigrace は 1 件（最安 2000・同額なら id の小さい p2）");
});
