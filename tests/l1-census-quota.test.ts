// ============================================================
// census を 10/6 の告知までに一巡させるための枠（2026-09-29）と、支払い後の台帳の書き込みを落とさない文字の扱い。
// DB 無しで固定する部分。予約の SQL・購入の経路は l1-ledger-census.pg.test.ts。
//
//  1. OBSERVATORY_L1_CENSUS_MIN_PER_RUN: 既定 0＝従来どおり（retest が先に全部取れる）。census の最低枠は
//     CENSUS_PER_RUN（40）で頭打ち。壊れた値は 0。
//  2. OBSERVATORY_L1_CENSUS_FIRST_PURCHASE_QUOTA: 既定は初回購入の日次枠そのもの（120）。広げるだけで狭めない。
//     上限 CENSUS_FIRST_PURCHASE_QUOTA_MAX。壊れた値は既定。
//  3. planCensusAndRetest: 枠の配分と並び。最低枠 0 なら従来と同じ（retest → census・census は残り）。
//     最低枠 > 0 なら census（最低枠）→ retest → census（残り）。census が足りなければ余りは retest へ。
//     同じホスト・同じ出品を 2 度入れない。合計は CENSUS_PER_RUN を超えない。
//  4. pgSafeText / pgSafeJson: U+0000 を落とし、孤立サロゲートを U+FFFD に（jsonb が受け付けない 2 つ）。
//  5. dbErrorCause: drizzle の包みの cause から SQLSTATE と本文を取り出す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CENSUS_FIRST_PURCHASE_QUOTA_MAX,
  CENSUS_PER_RUN,
  censusFirstPurchaseQuota,
  censusMinPerRun,
} from "@/lib/observatory/budget";
import { FIRST_PURCHASE_DAILY_QUOTA, dbErrorCause, pgSafeJson, pgSafeText, planCensusAndRetest } from "@/lib/observatory/l1-runner";

function withEnv(name: string, value: string | undefined, fn: () => void | Promise<void>) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  const restore = () => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

test("OBSERVATORY_L1_CENSUS_MIN_PER_RUN: 既定 0・整数だけ・CENSUS_PER_RUN で頭打ち", () => {
  assert.equal(CENSUS_PER_RUN, 40);
  const cases: [string | undefined, number][] = [
    [undefined, 0],
    ["", 0],
    ["0", 0],
    ["15", 15],
    [" 20 ", 20],
    ["40", 40],
    ["41", 40],
    ["1000", 40],
    ["-1", 0],
    ["1.5", 0],
    ["1e1", 0],
    ["0x10", 0],
    ["abc", 0],
  ];
  for (const [raw, want] of cases) withEnv("OBSERVATORY_L1_CENSUS_MIN_PER_RUN", raw, () => assert.equal(censusMinPerRun(), want, String(raw)));
});

test("OBSERVATORY_L1_CENSUS_FIRST_PURCHASE_QUOTA: 既定は 120 のまま・広げるだけ・上限あり", () => {
  assert.equal(FIRST_PURCHASE_DAILY_QUOTA, 120, "既定の初回購入の日次枠は変えていない");
  const q = () => censusFirstPurchaseQuota(FIRST_PURCHASE_DAILY_QUOTA);
  const cases: [string | undefined, number][] = [
    [undefined, 120],
    ["", 120],
    ["abc", 120],
    ["-5", 120],
    ["150.5", 120],
    ["0", 120],
    ["50", 120],
    ["120", 120],
    ["121", 121],
    ["200", 200],
    [String(CENSUS_FIRST_PURCHASE_QUOTA_MAX), CENSUS_FIRST_PURCHASE_QUOTA_MAX],
    ["100000", CENSUS_FIRST_PURCHASE_QUOTA_MAX],
  ];
  for (const [raw, want] of cases) withEnv("OBSERVATORY_L1_CENSUS_FIRST_PURCHASE_QUOTA", raw, () => assert.equal(q(), want, String(raw)));
});

// ---- planCensusAndRetest ----
const row = (id: string, host: string, price: string) => ({
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
});
/** SQL の代わり: 安い順に並んだ行の先頭 limit 件（除外は知らない——SQL も知らない）。呼ばれた limit を記録する。 */
const source = (rows: ReturnType<typeof row>[]) => {
  const calls: number[] = [];
  return { calls, fetch: async (limit: number) => (calls.push(limit), rows.slice(0, limit)) };
};
const censusRows = (n: number) => Array.from({ length: n }, (_, i) => row(`c${String(i).padStart(3, "0")}`, `census${i}.example`, String(1000 + i)));
const retestRows = (n: number) => Array.from({ length: n }, (_, i) => row(`r${String(i).padStart(3, "0")}`, `retest${i}.example`, String(1000 + i)));

test("planCensusAndRetest: 最低枠 0 は従来どおり（retest が 40 を取れば census は 0）", async () => {
  const c = source(censusRows(100));
  const r = source(retestRows(100));
  const plan = await planCensusAndRetest({ censusOn: true, retestOn: true, perRun: 40, censusMin: 0, excludeIds: new Set(), fetchCensus: c.fetch, fetchRetest: r.fetch });
  assert.equal(plan.retestCount, 40);
  assert.equal(plan.censusCount, 0);
  assert.ok(plan.head.every((x) => x.selection === "retest"));
  assert.deepEqual(c.calls, [], "census の問い合わせは 1 本も出ない（残りの枠が 0）");
});

test("planCensusAndRetest: 最低枠 0 で retest が少なければ census が残りを取る（従来の並び retest → census）", async () => {
  const plan = await planCensusAndRetest({
    censusOn: true,
    retestOn: true,
    perRun: 40,
    censusMin: 0,
    excludeIds: new Set(),
    fetchCensus: source(censusRows(100)).fetch,
    fetchRetest: source(retestRows(12)).fetch,
  });
  assert.equal(plan.retestCount, 12);
  assert.equal(plan.censusCount, 28);
  assert.deepEqual(
    plan.head.map((x) => x.selection),
    [...Array(12).fill("retest"), ...Array(28).fill("census")],
  );
});

test("planCensusAndRetest: 最低枠 15 は retest が 100 残っていても census に 15 件・census が先頭", async () => {
  const plan = await planCensusAndRetest({
    censusOn: true,
    retestOn: true,
    perRun: 40,
    censusMin: 15,
    excludeIds: new Set(),
    fetchCensus: source(censusRows(100)).fetch,
    fetchRetest: source(retestRows(100)).fetch,
  });
  assert.equal(plan.censusCount, 15);
  assert.equal(plan.retestCount, 25);
  assert.equal(plan.head.length, CENSUS_PER_RUN, "合計は CENSUS_PER_RUN を超えない");
  assert.deepEqual(
    plan.head.map((x) => x.selection),
    [...Array(15).fill("census"), ...Array(25).fill("retest")],
    "census の最低枠は retest より前（1 回のバッチが回せる件数に収まるように）",
  );
  assert.deepEqual(
    plan.head.slice(0, 15).map((x) => x.id),
    censusRows(15).map((x) => x.id),
    "census は安い順",
  );
});

test("planCensusAndRetest: census が最低枠に足りなければ、余りは retest へ戻す", async () => {
  const plan = await planCensusAndRetest({
    censusOn: true,
    retestOn: true,
    perRun: 40,
    censusMin: 15,
    excludeIds: new Set(),
    fetchCensus: source(censusRows(5)).fetch,
    fetchRetest: source(retestRows(100)).fetch,
  });
  assert.equal(plan.censusCount, 5);
  assert.equal(plan.retestCount, 35);
});

test("planCensusAndRetest: retest が少なければ census が残りも取る（最低枠 → retest → census の残り）", async () => {
  const plan = await planCensusAndRetest({
    censusOn: true,
    retestOn: true,
    perRun: 40,
    censusMin: 15,
    excludeIds: new Set(),
    fetchCensus: source(censusRows(100)).fetch,
    fetchRetest: source(retestRows(10)).fetch,
  });
  assert.equal(plan.retestCount, 10);
  assert.equal(plan.censusCount, 30);
  assert.deepEqual(
    plan.head.map((x) => x.selection),
    [...Array(15).fill("census"), ...Array(10).fill("retest"), ...Array(15).fill("census")],
  );
  const ids = plan.head.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "同じ出品を 2 度入れない（census の 2 回目は 1 回目の続きから）");
  assert.deepEqual(
    plan.head.filter((x) => x.selection === "census").map((x) => x.id),
    censusRows(30).map((x) => x.id),
  );
});

test("planCensusAndRetest: 同じホストは 1 回だけ（census の最低枠に入った売り手を retest で重ねない）・除外 id を守る", async () => {
  const shared = row("shared-r", "census0.example", "999");
  const plan = await planCensusAndRetest({
    censusOn: true,
    retestOn: true,
    perRun: 40,
    censusMin: 3,
    excludeIds: new Set(["c001"]),
    fetchCensus: source(censusRows(10)).fetch,
    fetchRetest: source([shared, ...retestRows(5)]).fetch,
  });
  const hosts = plan.head.map((x) => new URL(x.resourceUrl).host);
  assert.equal(new Set(hosts).size, hosts.length, `ホストの重複なし: ${hosts.join(", ")}`);
  assert.ok(!plan.head.some((x) => x.id === "c001"), "レーン枠に入った出品は入れない");
  assert.ok(!plan.head.some((x) => x.id === "shared-r"), "census の最低枠に入ったホストは retest に入れない");
});

test("planCensusAndRetest: census の旗が無ければ最低枠は効かない（何も問い合わせない）", async () => {
  const c = source(censusRows(10));
  const r = source(retestRows(10));
  const plan = await planCensusAndRetest({ censusOn: false, retestOn: false, perRun: 40, censusMin: 15, excludeIds: new Set(), fetchCensus: c.fetch, fetchRetest: r.fetch });
  assert.deepEqual(plan, { head: [], censusCount: 0, retestCount: 0 });
  assert.deepEqual(c.calls, []);
  assert.deepEqual(r.calls, []);
});

// ---- 文字の扱い・誤りの原因 ----
test("pgSafeText / pgSafeJson: U+0000 を落とし、孤立サロゲートを U+FFFD に。正しいサロゲート対は残す", () => {
  assert.equal(pgSafeText("a\u0000b"), "ab");
  assert.equal(pgSafeText("x\ud83d"), "x�", "slice の切れ目の上位サロゲート");
  assert.equal(pgSafeText("\ude00y"), "�y", "孤立した下位サロゲート");
  assert.equal(pgSafeText("ok 😀 日本語"), "ok 😀 日本語");
  // gzip の先頭（1f 8b 08 00 …）を文字列にしたもの。
  const gzipHead = new TextDecoder().decode(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]));
  assert.ok(gzipHead.includes("\u0000"));
  assert.ok(!pgSafeText(gzipHead).includes("\u0000"));
  const meta = pgSafeJson({ "k\u0000": ["\u0000v", 1, null, true, { deep: "\ud800" }], n: 5 });
  assert.deepEqual(meta, { k: ["v", 1, null, true, { deep: "�" }], n: 5 });
  assert.equal(pgSafeJson(null), null);
  assert.ok(!JSON.stringify(meta).includes("\\u0000"));
});

test("dbErrorCause: drizzle の包みの cause から SQLSTATE と本文。原因の無い誤りは null・URL は伏字", () => {
  const wrapped = Object.assign(new Error('Failed query: update "x402_l1_purchases" set ... params: delivered_no_receipt,...'), {
    cause: Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" }),
  });
  assert.deepEqual(dbErrorCause(wrapped), { code: "22P05", message: "Error: unsupported Unicode escape sequence" });
  assert.equal(dbErrorCause(new Error("plain")), null);
  const withUrl = Object.assign(new Error("outer"), { cause: new Error("fetch https://rpc.example/v2/SECRETKEY failed") });
  assert.ok(!dbErrorCause(withUrl)!.message.includes("SECRETKEY"));
});
