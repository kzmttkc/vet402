// ============================================================
// /decision の L0 は公開規則（直近 2 本が連続で fail なら fail）を窓の外まで数える（2026-11-02）。
//
// loadSellerFacts のプローブは 30 日窓で読む。失敗している出品はプローブの間隔が空くので、2 本目の fail が
// 窓から落ちると /decision だけ unverified（l0_unverified_single_fail・WARN）と答え、同じプローブを窓なしで
// 読む L0 の export と記録ページは fail と出していた（surface-canary の Issue #87）。
//
// 固定すること:
//   1. 窓の外を読むのは、窓の中に 1 本以上あって全部 fail で、本数がゲートに届かないときだけ
//   2. 窓の外の verdict は l0.status と l0UnverifiedCauseOf だけに効く
//   3. 窓の中に 1 本も無い出品の status と推奨は変えない。原因の語だけ、窓の外に行があれば no_recent_probe
// 実際の SQL と読む回数は tests/decision-l0-streak-window.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { reasonCodeDocOf } from "@/lib/decision/reason-codes";
import { decidePayer } from "@/lib/decision/rules";
import {
  assembleSellerFacts,
  l0UnverifiedCauseOf,
  l0VerdictsNeededBeforeWindow,
  type ProbeInput,
  type SellerFactsInput,
} from "@/lib/decision/seller-facts";
import { publishedVerdict } from "@/lib/observatory/l0-verdict";

const NOW = Date.parse("2026-11-02T00:00:00Z");
const probe = (verdict: string, probedAt = "2026-10-21 10:30:55.621857+00", failReason: string | null = "no_402"): ProbeInput => ({
  probedAt,
  verdict,
  dialect: null,
  failReason: verdict === "pass" ? null : failReason,
  priceAmount: "declared",
  priceAsset: null,
  payTo: "declared",
});
const input = (probes: ProbeInput[], l0VerdictsBeforeWindow?: string[]): SellerFactsInput => ({
  probes,
  ...(l0VerdictsBeforeWindow ? { l0VerdictsBeforeWindow } : {}),
  purchases: [],
  settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
  payees: [],
  declaredSchema: null,
  lastAttemptAt: null,
});

test("窓の外を読む本数: 窓の中が全部 fail で、ゲートに届かないときだけ足りない本数", () => {
  assert.equal(l0VerdictsNeededBeforeWindow([probe("fail")]), 1);
  assert.equal(l0VerdictsNeededBeforeWindow([probe("fail"), probe("fail")]), 0, "2 本あれば読まない");
  assert.equal(l0VerdictsNeededBeforeWindow([probe("pass")]), 0, "pass は窓の外で変わらない");
  assert.equal(l0VerdictsNeededBeforeWindow([probe("unverified", undefined, "tls")]), 0, "連続が始まっていない");
  assert.equal(l0VerdictsNeededBeforeWindow([]), 0, "窓の中に 0 本の出品は今の答えのまま");
});

test("窓の中に fail 1 本＋窓の外に fail 1 本 → fail（BLOCK・l0_fail）", () => {
  const i = input([probe("fail")], ["fail"]);
  const f = assembleSellerFacts(i);
  assert.equal(f.l0.status, "fail");
  assert.equal(f.l0.fail_reason, "no_402", "理由は窓の中の最新の行");
  assert.equal(f.l0.observed_at, "2026-10-21 10:30:55.621857+00", "観測時刻も窓の中の最新の行");
  assert.equal(l0UnverifiedCauseOf(i.probes, i.l0VerdictsBeforeWindow), null);
  const d = decidePayer(f, { l0UnverifiedCause: l0UnverifiedCauseOf(i.probes, i.l0VerdictsBeforeWindow) });
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("l0_fail"), d.reason_codes.join());
  assert.ok(!d.reason_codes.includes("l0_unverified_single_fail"), d.reason_codes.join());
});

test("窓の中に fail 1 本＋窓の外に pass → unverified / single_fail（BLOCK にしない）", () => {
  const i = input([probe("fail")], ["pass"]);
  const f = assembleSellerFacts(i);
  assert.equal(f.l0.status, "unverified");
  assert.equal(f.l0.fail_reason, null);
  const cause = l0UnverifiedCauseOf(i.probes, i.l0VerdictsBeforeWindow);
  assert.equal(cause, "single_fail");
  assert.notEqual(decidePayer(f, { l0UnverifiedCause: cause }).recommendation, "BLOCK");
});

test("窓の中に fail 1 本＋窓の外に unverified → unverified / single_fail（export の直近 2 本と同じ）", () => {
  const i = input([probe("fail")], ["unverified"]);
  assert.equal(assembleSellerFacts(i).l0.status, "unverified");
  assert.equal(l0UnverifiedCauseOf(i.probes, i.l0VerdictsBeforeWindow), "single_fail");
  assert.equal(publishedVerdict(["fail", "unverified"]), "unverified");
});

test("窓の中に fail 1 本で窓の外に 1 本も無い → unverified / single_fail（本当に 1 回だけ）", () => {
  const i = input([probe("fail")], []);
  assert.equal(assembleSellerFacts(i).l0.status, "unverified");
  assert.equal(l0UnverifiedCauseOf(i.probes, i.l0VerdictsBeforeWindow), "single_fail");
});

test("窓の中に fail 2 本 → fail、窓の中が pass → pass（窓の外の材料なしで今と同じ）", () => {
  assert.equal(assembleSellerFacts(input([probe("fail"), probe("fail")])).l0.status, "fail");
  assert.equal(assembleSellerFacts(input([probe("pass")])).l0.status, "pass");
  assert.equal(l0UnverifiedCauseOf([probe("fail"), probe("fail")]), null, "引数 1 つの呼び方も今と同じ");
  assert.equal(l0UnverifiedCauseOf([probe("fail")]), "single_fail", "引数 1 つの呼び方も今と同じ");
});

test("窓の中に 0 本（窓の外に fail 2 本）→ unverified（読むのは有無だけ）", () => {
  const i = input([]);
  assert.equal(l0VerdictsNeededBeforeWindow(i.probes), 0);
  assert.equal(assembleSellerFacts(i).l0.status, "unverified");
  assert.equal(l0UnverifiedCauseOf(i.probes), "not_probed", "1 度も測っていない");
  assert.equal(l0UnverifiedCauseOf(i.probes, [], true), "no_recent_probe", "窓の外に行がある");
});

test("no_recent_probe: 語だけが変わり、status と推奨は not_probed と同じ", () => {
  const f = assembleSellerFacts(input([]));
  const notProbed = decidePayer(f, { l0UnverifiedCause: "not_probed" });
  const noRecent = decidePayer(f, { l0UnverifiedCause: "no_recent_probe" });
  assert.equal(noRecent.recommendation, notProbed.recommendation);
  assert.ok(noRecent.reason_codes.includes("l0_unverified_no_recent_probe"), noRecent.reason_codes.join());
  assert.ok(!noRecent.reason_codes.includes("l0_unverified_not_probed"), noRecent.reason_codes.join());
  assert.equal(reasonCodeDocOf("l0_unverified_no_recent_probe")?.effect, "WARN");
  assert.equal(l0UnverifiedCauseOf([probe("pass")], [], true), null, "pass なら原因なし（窓の外の有無は効かない）");
  assert.equal(l0UnverifiedCauseOf([probe("fail")], [], true), "single_fail", "窓の中に行があれば no_recent_probe にしない");
});

test("窓の外の verdict は offer_stability にも availability にも観測時刻にも混ざらない", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const window = [probe("fail")];
  const without = assembleSellerFacts(input(window, []));
  const withBefore = assembleSellerFacts(input(window, ["fail", "pass", "pass", "pass"]));
  assert.equal(without.offer_stability, "unknown", "窓の中に pass が無い");
  assert.equal(withBefore.offer_stability, "unknown", "窓の外の pass を数えると stable に化ける");
  assert.equal(withBefore.availability_30d, 0);
  assert.equal(withBefore.availability_7d, without.availability_7d);
  assert.equal(withBefore.l0.observed_at, without.l0.observed_at);
  assert.equal(withBefore.l0.dialect, without.l0.dialect);
  // 違うのは l0 の判定と理由だけ。
  assert.deepEqual({ ...withBefore, l0: null }, { ...without, l0: null });
  assert.equal(withBefore.l0.status, "fail");
});
