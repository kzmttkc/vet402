// ============================================================
// 2026-09-05: /api/v1/census/summary の `indexed_since`。
//
// なぜ在るか: 応答は `window: "30d"` と名乗るだけで、**索引がいつから存在するか**を
// 返していなかった。読む側は「30 日ぶんの数字」と読むしかないが、実測では
// 2026-09-04 時点で eip155:8453 の最古の日は 2026-08-23（13 日ぶん）、
// solana は 2026-07-21（46 日ぶん）で、チェーンごとに違う。分母を売るなら、
// 分母の期間を応答だけで確かめられなければならない。
//
// ここで固定するのは境界の算術だけ（純粋関数）。SQL と応答の形は
// tests/census-indexed-since.pg.test.ts が実 Postgres で確かめる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { windowCoverage, CENSUS_INDEXED_SINCE_NOTE } from "@/lib/settlements/census";
import { RAW_RETENTION_DAYS } from "@/lib/settlements/rollup";

const TODAY = "2026-09-04";

test("索引が 1 件も無ければ 0 日・未充足（黙って 30 日を名乗らない）", () => {
  assert.deepEqual(windowCoverage(null, TODAY, 30), {
    window_requested_days: 30,
    window_covered_days: 0,
    window_fully_covered: false,
  });
});

test("最古日が窓の開始より古ければ、要求どおり満たしている", () => {
  // 30d の窓は today-29 .. today（両端含む）= 30 UTC 日。
  const r = windowCoverage("2026-07-21", TODAY, 30);
  assert.equal(r.window_covered_days, 30);
  assert.equal(r.window_fully_covered, true);
});

test("最古日が窓の開始とちょうど同じ日なら満たしている（境界の内側）", () => {
  const r = windowCoverage("2026-08-06", TODAY, 30); // = today - 29
  assert.equal(r.window_covered_days, 30);
  assert.equal(r.window_fully_covered, true);
});

test("最古日が窓の開始より 1 日新しいと 29 日・未充足（境界の外側）", () => {
  const r = windowCoverage("2026-08-07", TODAY, 30);
  assert.equal(r.window_covered_days, 29);
  assert.equal(r.window_fully_covered, false);
});

test("本番実測: eip155:8453 の 2026-08-23 は 30d 窓の 13 日ぶんでしかない", () => {
  const r = windowCoverage("2026-08-23", TODAY, 30);
  assert.deepEqual(r, {
    window_requested_days: 30,
    window_covered_days: 13,
    window_fully_covered: false,
  });
});

test("今日が最初の日なら 1 日（0 日ではない。今日ぶんは持っている）", () => {
  const r = windowCoverage(TODAY, TODAY, 30);
  assert.equal(r.window_covered_days, 1);
  assert.equal(r.window_fully_covered, false);
});

test("7d 窓の境界も同じ規則で数える", () => {
  assert.equal(windowCoverage("2026-08-29", TODAY, 7).window_covered_days, 7); // = today - 6
  assert.equal(windowCoverage("2026-08-29", TODAY, 7).window_fully_covered, true);
  assert.equal(windowCoverage("2026-08-30", TODAY, 7).window_covered_days, 6);
  assert.equal(windowCoverage("2026-08-30", TODAY, 7).window_fully_covered, false);
});

test("窓より長い索引を持っていても、要求した日数を超えて名乗らない", () => {
  assert.equal(windowCoverage("2020-01-01", TODAY, 7).window_covered_days, 7);
  assert.equal(windowCoverage("2020-01-01", TODAY, 30).window_covered_days, 30);
});

test("最古日が未来（索引の異常）でも 0 に落として偽の充足を返さない", () => {
  const r = windowCoverage("2026-09-05", TODAY, 30);
  assert.equal(r.window_covered_days, 0);
  assert.equal(r.window_fully_covered, false);
});

test("読めない日付は 0 日・未充足（NaN を日数として出さない）", () => {
  const r = windowCoverage("not-a-date", TODAY, 30);
  assert.equal(r.window_covered_days, 0);
  assert.equal(r.window_fully_covered, false);
});

test("note は何を数えて何を数えないかを応答の中で述べる（生行の保持日数を含む）", () => {
  assert.ok(CENSUS_INDEXED_SINCE_NOTE.includes(String(RAW_RETENTION_DAYS)), "生行の保持日数が note に無い");
  assert.match(CENSUS_INDEXED_SINCE_NOTE, /daily aggregate/i);
  assert.match(CENSUS_INDEXED_SINCE_NOTE, /no per-transaction receipts/i);
  assert.match(CENSUS_INDEXED_SINCE_NOTE, /byChain/);
});
