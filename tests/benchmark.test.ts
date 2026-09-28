// ============================================================
// Vouch — operator benchmark: dataset integrity + report arithmetic.
//
// The benchmark exists to break /accuracy's chicken-and-egg problem
// WITHOUT lying about where the data came from, so the tests guard two
// things: (1) the dataset itself stays well-formed and honestly sourced
// (every entry carries a source; addresses are unique, valid, lowercase),
// and (2) the published rates follow the same honesty rules as the
// external report — dedup to one count per address, unflattering numbers
// computed with the same machinery, no rate below the minimum sample.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_DATASET,
  BENCHMARK_SEED_KIND,
  OPERATOR_BENCHMARK_SOURCE,
} from "@/lib/benchmark/dataset";
import { MIN_SAMPLE } from "@/lib/scoring/accuracy";
import {
  computeBenchmarkReport,
  type BenchmarkRow,
} from "@/lib/scoring/benchmark-report";
import {
  benchmarkScanFailed,
  cooldownWaitMs,
  entryBudgetMs,
  errorReasonKey,
  orderByStaleness,
  tallyErrorReason,
  toLastScannedMap,
} from "@/lib/benchmark/runner";

// ---------- dataset integrity ----------

test("dataset: every address is a valid lowercase 0x address", () => {
  for (const entry of BENCHMARK_DATASET) {
    assert.match(
      entry.address,
      /^0x[a-f0-9]{40}$/,
      `not a lowercase address: ${entry.address}`,
    );
  }
});

test("dataset: addresses are unique", () => {
  const seen = new Set(BENCHMARK_DATASET.map((e) => e.address));
  assert.equal(seen.size, BENCHMARK_DATASET.length);
});

test("dataset: every entry carries a source name, url and note", () => {
  for (const entry of BENCHMARK_DATASET) {
    assert.ok(entry.sourceName.length > 0, entry.address);
    assert.match(entry.sourceUrl, /^https:\/\//, entry.address);
    assert.ok(entry.note.length > 0, entry.address);
    assert.ok(entry.label === "bad" || entry.label === "good", entry.address);
  }
});

test("dataset: both classes reach the minimum publishable sample", () => {
  const bad = BENCHMARK_DATASET.filter((e) => e.label === "bad").length;
  const good = BENCHMARK_DATASET.filter((e) => e.label === "good").length;
  assert.ok(bad >= MIN_SAMPLE, `known-bad ${bad} < MIN_SAMPLE ${MIN_SAMPLE}`);
  assert.ok(good >= MIN_SAMPLE, `known-good ${good} < MIN_SAMPLE ${MIN_SAMPLE}`);
});

test("dataset: interleaved so a truncated run samples both classes", () => {
  // The first 2*MIN_SAMPLE entries must contain both labels — that is the
  // property a time-budget-truncated cron pass relies on.
  const head = BENCHMARK_DATASET.slice(0, MIN_SAMPLE * 2);
  assert.ok(head.some((e) => e.label === "bad"));
  assert.ok(head.some((e) => e.label === "good"));
});

test("separation markers are the documented literals", () => {
  // These strings are load-bearing across modules (runner writes them,
  // outcome-reader partitions on them, outcome-writer excludes them) and in
  // raw SQL fragments that cannot import the constant. Lock them down.
  assert.equal(OPERATOR_BENCHMARK_SOURCE, "operator_benchmark");
  assert.equal(BENCHMARK_SEED_KIND, "benchmark_seed");
});

// ---------- report arithmetic ----------

let seq = 0;
function row(over: Partial<BenchmarkRow>): BenchmarkRow {
  return {
    relatedWallet: over.relatedWallet ?? `0x${String(seq++).padStart(40, "0")}`,
    recommendation: "BLOCK",
    outcomeType: "confirmed_fraud",
    detectedAt: "2026-08-06T00:00:00Z",
    ...over,
  };
}

function batch(n: number, over: Partial<BenchmarkRow>): BenchmarkRow[] {
  return Array.from({ length: n }, () =>
    row({ ...over, relatedWallet: `0x${String(seq++).padStart(40, "0")}` }),
  );
}

test("empty input produces an honest empty report", () => {
  const r = computeBenchmarkReport([]);
  assert.equal(r.knownBad.total, 0);
  assert.equal(r.knownGood.total, 0);
  assert.equal(r.knownBad.detectionRate, null);
  assert.equal(r.knownGood.falsePositiveRate, null);
  assert.equal(r.lastScanAt, null);
});

test("known-bad: BLOCK and WARN are detections, ALLOW is a miss", () => {
  const rows = [
    ...batch(MIN_SAMPLE, { outcomeType: "confirmed_fraud", recommendation: "BLOCK" }),
    ...batch(MIN_SAMPLE, { outcomeType: "confirmed_fraud", recommendation: "WARN" }),
    ...batch(MIN_SAMPLE * 2, { outcomeType: "confirmed_fraud", recommendation: "ALLOW" }),
  ];
  const r = computeBenchmarkReport(rows);
  assert.equal(r.knownBad.total, MIN_SAMPLE * 4);
  assert.equal(r.knownBad.detected, MIN_SAMPLE * 2);
  assert.equal(r.knownBad.missed, MIN_SAMPLE * 2);
  assert.equal(r.knownBad.detectionRate, 50);
  assert.equal(r.knownBad.missRate, 50);
});

test("known-good: only BLOCK counts as a false positive; WARN is reported but not a rate", () => {
  const rows = [
    ...batch(MIN_SAMPLE * 2, { outcomeType: "confirmed_legitimate", recommendation: "ALLOW" }),
    ...batch(MIN_SAMPLE, { outcomeType: "confirmed_legitimate", recommendation: "WARN" }),
    ...batch(MIN_SAMPLE, { outcomeType: "confirmed_legitimate", recommendation: "BLOCK" }),
  ];
  const r = computeBenchmarkReport(rows);
  assert.equal(r.knownGood.total, MIN_SAMPLE * 4);
  assert.equal(r.knownGood.allowed, MIN_SAMPLE * 2);
  assert.equal(r.knownGood.warned, MIN_SAMPLE);
  assert.equal(r.knownGood.blocked, MIN_SAMPLE);
  assert.equal(r.knownGood.falsePositiveRate, 25);
});

test("re-scans do not multiply the sample: latest scan per address wins", () => {
  const wallet = "0x" + "ab".repeat(20);
  const rows: BenchmarkRow[] = [
    row({
      relatedWallet: wallet,
      outcomeType: "confirmed_fraud",
      recommendation: "ALLOW",
      detectedAt: "2026-07-01T00:00:00Z",
    }),
    row({
      relatedWallet: wallet,
      outcomeType: "confirmed_fraud",
      recommendation: "BLOCK",
      detectedAt: "2026-08-01T00:00:00Z",
    }),
  ];
  const r = computeBenchmarkReport(rows);
  assert.equal(r.knownBad.total, 1);
  assert.equal(r.knownBad.detected, 1);
  assert.equal(r.knownBad.missed, 0);
  assert.equal(r.scans, 2); // raw scan count still reported honestly
});

test("address dedup is case-insensitive", () => {
  const rows: BenchmarkRow[] = [
    row({ relatedWallet: "0x" + "AB".repeat(20), outcomeType: "confirmed_fraud" }),
    row({ relatedWallet: "0x" + "ab".repeat(20), outcomeType: "confirmed_fraud" }),
  ];
  const r = computeBenchmarkReport(rows);
  assert.equal(r.knownBad.total, 1);
});

test("below the minimum sample, rates are null, never noise", () => {
  const rows = batch(MIN_SAMPLE - 1, {
    outcomeType: "confirmed_fraud",
    recommendation: "BLOCK",
  });
  const r = computeBenchmarkReport(rows);
  assert.equal(r.knownBad.total, MIN_SAMPLE - 1);
  assert.equal(r.knownBad.detectionRate, null);
  assert.equal(r.knownBad.missRate, null);
});

test("unknown outcome types and null wallets are ignored, not misfiled", () => {
  const rows: BenchmarkRow[] = [
    row({ outcomeType: "some_future_type" }),
    row({ relatedWallet: null }),
    ...batch(1, { outcomeType: "confirmed_fraud", recommendation: "BLOCK" }),
  ];
  const r = computeBenchmarkReport(rows);
  assert.equal(r.knownBad.total, 1);
  assert.equal(r.knownGood.total, 0);
  assert.equal(r.scans, 1);
});

test("null or unknown recommendations are excluded from totals", () => {
  const rows: BenchmarkRow[] = [
    row({ outcomeType: "confirmed_fraud", recommendation: null }),
    row({ outcomeType: "confirmed_fraud", recommendation: "MAYBE" }),
  ];
  const r = computeBenchmarkReport(rows);
  assert.equal(r.knownBad.total, 0);
});

// ---------- 走行の予算と、沈黙の禁止（2026-08-13） ----------
//
// WHY. 週次 cron は「1件目のスコアリングが終わらない」だけで殺され、
// trust_events に1行も書けないまま ok:true を返し続けていた。時間の切り方に
// per-entry の上限が無かったこと（budget は entry と entry の間でしか見ない）と、
// recorded=0 がどこにも異常として現れないことの2つが、7日ごとの沈黙を作っていた。

test("entryBudget: 1件が使える時間は、残り時間と1件あたり上限の小さい方", () => {
  assert.equal(entryBudgetMs({ elapsedMs: 0, totalBudgetMs: 240_000, perEntryMaxMs: 20_000 }), 20_000);
  assert.equal(entryBudgetMs({ elapsedMs: 230_000, totalBudgetMs: 240_000, perEntryMaxMs: 20_000 }), 10_000);
});

test("entryBudget: 総予算を使い切ったら 0（＝新しい1件を始めない）", () => {
  assert.equal(entryBudgetMs({ elapsedMs: 240_000, totalBudgetMs: 240_000, perEntryMaxMs: 20_000 }), 0);
  assert.equal(entryBudgetMs({ elapsedMs: 999_000, totalBudgetMs: 240_000, perEntryMaxMs: 20_000 }), 0);
});

test("走査したのに1行も記録できなかった run は成功ではない", () => {
  assert.equal(benchmarkScanFailed({ scanned: 42, recorded: 0, errors: 42, skipped: 0, unmeasured: 0, datasetVersion: 1 }), true);
  assert.equal(benchmarkScanFailed({ scanned: 42, recorded: 1, errors: 41, skipped: 0, unmeasured: 0, datasetVersion: 1 }), false);
});

test("DB未設定で1件も走査しなかった run は失敗扱いにしない（既存の degrade-to-no-op を壊さない）", () => {
  assert.equal(benchmarkScanFailed({ scanned: 0, recorded: 0, errors: 0, skipped: 42, unmeasured: 0, datasetVersion: 1 }), false);
});

// ============================================================
// 2026-08-13: 制限に触れた瞬間、残り33件が6秒で燃え尽きた。
// 失敗は速い——1回のクールダウン(10秒)の中に、走査すべきアドレスの8割が
// 収まってしまい、全部「読めなかった」として BLOCK で記録された。
// この run には240秒の予算があり、待っている人間は居ない。
// ============================================================
test("クールダウン中は次の1件を始めない（ただし総予算は超えない）", () => {
  // 制限中: 残り予算があるだけ待つ
  assert.equal(
    cooldownWaitMs({ cooldownRemainingMs: 10_000, elapsedMs: 30_000, totalBudgetMs: 240_000 }),
    10_000,
  );
  // 制限が明けている: 待たない
  assert.equal(
    cooldownWaitMs({ cooldownRemainingMs: 0, elapsedMs: 30_000, totalBudgetMs: 240_000 }),
    0,
  );
  // 予算が尽きかけている: 待ちは残り予算で頭打ち（走行ごと殺されない）
  assert.equal(
    cooldownWaitMs({ cooldownRemainingMs: 10_000, elapsedMs: 236_000, totalBudgetMs: 240_000 }),
    4_000,
  );
  // 予算超過: 1ミリ秒も待たない
  assert.equal(
    cooldownWaitMs({ cooldownRemainingMs: 10_000, elapsedMs: 250_000, totalBudgetMs: 240_000 }),
    0,
  );
});

// ============================================================
// 2026-08-13: 走査は常に index 0 から始まっていた。上流が1走行で許す
// 読み取りは実測9〜10件、対象は42件——先頭だけが繰り返し測られ、
// 後半24件は永久に測られない（実測 skipped:24）。
// ============================================================
test("走査は古い順（未走査が最優先）に並ぶ——同じ先頭を測り直し続けない", () => {
  const now = Date.now();
  const last = new Map<string, number>();
  // 先頭付近を「たった今測った」ことにする
  for (const e of BENCHMARK_DATASET.slice(0, 20)) last.set(e.address, now);

  const order = orderByStaleness(BENCHMARK_DATASET, last);

  assert.equal(order.length, BENCHMARK_DATASET.length, "件数は変わらない");
  assert.equal(
    new Set(order.map((e) => e.address)).size,
    BENCHMARK_DATASET.length,
    "重複も欠落もない",
  );

  // 直近で測った20件は、後ろへ回る
  const freshAddresses = new Set(BENCHMARK_DATASET.slice(0, 20).map((e) => e.address));
  const firstTen = order.slice(0, 10);
  const staleInFirstTen = firstTen.filter((e) => !freshAddresses.has(e.address)).length;
  assert.ok(
    staleInFirstTen >= 8,
    `先頭10件のうち未走査は ${staleInFirstTen} 件しかない——古い順になっていない`,
  );
});

test("古い順に並べ替えても bad/good は交互のまま（打ち切られても両クラスを標本する）", () => {
  const order = orderByStaleness(BENCHMARK_DATASET, new Map());
  const firstEight = order.slice(0, 8).map((e) => e.label);
  assert.ok(firstEight.includes("bad"), "先頭8件に bad が居ない");
  assert.ok(firstEight.includes("good"), "先頭8件に good が居ない");
  for (let i = 1; i < firstEight.length; i++) {
    assert.notEqual(firstEight[i], firstEight[i - 1], `${i} 番目で同じクラスが連続している`);
  }
});

test("db.execute の戻りが配列でも {rows:[...]} でも、走査時刻を読み落とさない", () => {
  // 2026-08-13: ここを配列決め打ちにしていたため Neon の {rows:[...]} で例外→
  // 空の地図→全件「未走査」→ staleness 順がアルファベット順に化けていた。
  // 本番でそれが見えた（古い3件が2回続けて飛ばされた）。
  const at = "2026-08-12T22:19:00.000Z";
  const expected = new Date(at).getTime();

  const fromArray = toLastScannedMap([{ wallet: "0xabc", last_at: at }]);
  assert.equal(fromArray.get("0xabc"), expected, "配列形を読めていない");

  const fromRows = toLastScannedMap({ rows: [{ wallet: "0xABC", last_at: new Date(at) }] });
  assert.equal(fromRows.get("0xabc"), expected, "{rows:[...]} 形を読めていない（本番のこれで壊れた）");

  // 壊れた行は無視するが、地図ごと空にはしない
  const mixed = toLastScannedMap({
    rows: [{ wallet: null, last_at: at }, { wallet: "0xdef", last_at: null }, { wallet: "0xfed", last_at: at }],
  });
  assert.equal(mixed.size, 1);
  assert.equal(mixed.get("0xfed"), expected);

  assert.equal(toLastScannedMap(undefined).size, 0, "読めない戻りは空の地図（例外にしない）");
});

test("走査時刻が読めていれば、古い3件が先頭に来る（本番で飛ばされた形）", () => {
  const good = BENCHMARK_DATASET.filter((e) => e.label === "good");
  const last = new Map<string, number>();
  // アルファベット順では後ろだが、実際には最も古い3件
  const stale = good.slice(-3);
  for (const e of good) last.set(e.address, Date.parse("2026-08-12T22:19:00Z"));
  for (const e of stale) last.set(e.address, Date.parse("2026-08-12T21:58:00Z"));

  const order = orderByStaleness(BENCHMARK_DATASET, last).filter((e) => e.label === "good");
  const headThree = new Set(order.slice(0, 3).map((e) => e.address));
  for (const e of stale) {
    assert.ok(headThree.has(e.address), `最も古い ${e.address} が先頭3件に居ない`);
  }
});

test("上流に届かず1件も測れなかった run は、静かに成功しない", () => {
  // 未計測を verdict として記録しなくなった以上、「全件未計測」は recorded 0 に
  // なる——benchmarkScanFailed が拾って cron が HTTP 500 を返す。隠れない。
  assert.equal(
    benchmarkScanFailed({ scanned: 42, recorded: 0, errors: 0, skipped: 0, unmeasured: 42, datasetVersion: 1 }),
    true,
  );
});

// ============================================================
// 2026-09-29: 42/42 が errors の run を手で叩いても応答に理由が無く、
// Vercel のログを掘るまで原因（agent_resolve の時間切れ）が見えなかった。
// ============================================================
test("errorReasons: 例外の1行目を理由にし、URL（鍵を含みうる）は落とす", () => {
  assert.equal(errorReasonKey(new Error("deadline_exceeded:agent_resolve:3000ms")), "deadline_exceeded:agent_resolve:3000ms");
  const key = errorReasonKey(new Error("RPC Request failed. https://base-mainnet.example/v2/SECRETKEY123\nRequest body: {...}"));
  assert.ok(!key.includes("SECRETKEY123"));
  assert.ok(!key.includes("Request body"));
});

test("errorReasons: 種類は上限までで、あふれた分は other にまとめる", () => {
  const reasons: Record<string, number> = {};
  for (let i = 0; i < 8; i++) tallyErrorReason(reasons, `r${i}`);
  tallyErrorReason(reasons, "r0");
  assert.equal(Object.keys(reasons).length, 6);
  assert.equal(reasons.r0, 2);
  assert.equal(reasons.other, 3);
});
