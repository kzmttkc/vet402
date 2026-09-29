// ============================================================
// 旧規則の公開 fail の見分けと、測り直しの印（2026-09-29 監査 6 周目）。純関数だけ。
// DB を通す部分（SQL 版との一致・書き込み・ドメインごとの間隔）は tests/l0-rule-change.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  legacyRuleFailKind,
  needsRuleChangeReprobe,
  politenessKeyOf,
  ruleChangeCorrection,
  type ProbeRowForRuleCheck,
} from "@/lib/observatory/l0-rule-change";
import { estimateReprobeSeconds } from "@/lib/observatory/l0-rule-change-reprobe";

const row = (over: Partial<ProbeRowForRuleCheck>): ProbeRowForRuleCheck => ({
  verdict: "fail",
  failReason: "no_402",
  method: "GET",
  httpStatus: 404,
  rawResponseMeta: { status: 404, bodyHead: "" },
  ...over,
});
const NEW_META = { status: 400, bodyHead: "", bodyBytes: 20 };
const LONG_V1_HEAD = `{"x402Version":1,"error":"X-PAYMENT header is required","accepts":[{"scheme":"exact","description":"${"d".repeat(480)}`;

test("legacyRuleFailKind: 旧規則の 3 種だけを拾い、今の規則の行・pass・他の理由は拾わない", () => {
  // 未払い POST の 400/422（旧い行＝bodyBytes なし）
  assert.equal(legacyRuleFailKind(row({ method: "POST", httpStatus: 400 })), "post_400_422_no_402");
  assert.equal(legacyRuleFailKind(row({ method: "post", httpStatus: 422 })), "post_400_422_no_402");
  // 今の計器の行（bodyBytes あり）で no_402 の POST 400 は、challenge ヘッダ付きの 400——今の規則でも fail
  assert.equal(legacyRuleFailKind(row({ method: "POST", httpStatus: 400, rawResponseMeta: NEW_META })), null);
  // GET の 400 は規則が変わっていない
  assert.equal(legacyRuleFailKind(row({ method: "GET", httpStatus: 400 })), null);
  assert.equal(legacyRuleFailKind(row({ method: "POST", httpStatus: 404 })), null);
  // 比べた値の記録が無い不一致
  assert.equal(legacyRuleFailKind(row({ failReason: "price_mismatch", httpStatus: 402 })), "mismatch_values_unrecorded");
  assert.equal(legacyRuleFailKind(row({ failReason: "metadata_mismatch", httpStatus: 402, rawResponseMeta: null })), "mismatch_values_unrecorded");
  assert.equal(
    legacyRuleFailKind(row({ failReason: "price_mismatch", httpStatus: 402, rawResponseMeta: { bodyBytes: 900, declared: { amount: "1" }, offered: [] } })),
    null,
  );
  // 4,000 バイトで切った疑い（先頭 500 字が埋まっていて x402 の語を含む）
  assert.equal(legacyRuleFailKind(row({ failReason: "accepts_invalid", httpStatus: 402, rawResponseMeta: { bodyHead: LONG_V1_HEAD.slice(0, 500) } })), "accepts_invalid_body_cut");
  assert.equal(legacyRuleFailKind(row({ failReason: "accepts_invalid", httpStatus: 402, rawResponseMeta: { bodyHead: "<html>" + "x".repeat(494) } })), null);
  assert.equal(legacyRuleFailKind(row({ failReason: "accepts_invalid", httpStatus: 402, rawResponseMeta: { bodyHead: "{}" } })), null);
  assert.equal(
    legacyRuleFailKind(row({ failReason: "accepts_invalid", httpStatus: 402, rawResponseMeta: { bodyHead: LONG_V1_HEAD.slice(0, 500), bodyBytes: 5000 } })),
    null,
  );
  // fail 以外は拾わない
  assert.equal(legacyRuleFailKind(row({ verdict: "unverified", failReason: "request_shape", method: "POST", httpStatus: 400 })), null);
  assert.equal(legacyRuleFailKind(row({ verdict: "pass", failReason: null })), null);
});

test("needsRuleChangeReprobe: 公開 fail で、新しい 2 行のどちらかが旧規則の行のときだけ", () => {
  const legacyPost = row({ method: "POST", httpStatus: 400 });
  const currentFail = row({ httpStatus: 404, rawResponseMeta: { status: 404, bodyBytes: 9 } });
  assert.equal(needsRuleChangeReprobe([legacyPost, legacyPost]), true);
  assert.equal(needsRuleChangeReprobe([currentFail, legacyPost]), true, "2 行目が旧規則の行でも見出しに効いている");
  assert.equal(needsRuleChangeReprobe([currentFail, currentFail, legacyPost]), false, "新しい 2 行が今の規則の fail なら対象外");
  assert.equal(needsRuleChangeReprobe([legacyPost]), false, "1 回の fail は公開されていない");
  assert.equal(needsRuleChangeReprobe([row({ verdict: "unverified", failReason: "request_shape" }), legacyPost, legacyPost]), false);
  assert.equal(needsRuleChangeReprobe([]), false);
});

test("politenessKeyOf: 同じ運営者のサブドメインを 1 つに数え、国別の 2 段接尾辞は 3 段で取る", () => {
  assert.equal(politenessKeyOf("https://mitteleuropa.halowerk.com/api/x"), "halowerk.com");
  assert.equal(politenessKeyOf("https://suedland.halowerk.com/api/y?q=1"), "halowerk.com");
  assert.equal(politenessKeyOf("https://intel.rallylive.ca/v1"), "rallylive.ca");
  assert.equal(politenessKeyOf("https://api.example.co.uk/a"), "example.co.uk");
  assert.equal(politenessKeyOf("https://example.com:8443/a"), "example.com");
  assert.equal(politenessKeyOf("http://203.0.113.9:8080/a"), "203.0.113.9");
  assert.equal(politenessKeyOf("not a url"), "not a url");
});

test("ruleChangeCorrection: 公開判定が変わったときだけ reverify の行を作り、何が旧規則だったかを before に残す", () => {
  assert.equal(ruleChangeCorrection({ endpointId: "e1", before: "fail", after: "fail", kinds: ["mismatch_values_unrecorded"], newFailReason: "price_mismatch" }), null);
  const c = ruleChangeCorrection({
    endpointId: "e1",
    before: "fail",
    after: "unverified",
    kinds: ["post_400_422_no_402", "post_400_422_no_402"],
    newFailReason: "request_shape",
  });
  assert.ok(c);
  assert.equal(c.reason, "reverify");
  assert.equal(c.level, "l0");
  assert.deepEqual(c.before, { publishedVerdict: "fail", legacyRuleRows: ["post_400_422_no_402"] });
  assert.equal(c.after.publishedVerdict, "unverified");
  assert.equal(c.after.failReason, "request_shape");
  assert.equal(c.after.trigger, "rule_change_reprobe");
});

test("estimateReprobeSeconds: 一番多いドメインの件数 × 間隔が下限", () => {
  const targets = [
    ...Array.from({ length: 90 }, (_, i) => ({ resourceUrl: `https://a${i % 3}.big.example/x${i}`, medianLatencyMs: 200 })),
    ...Array.from({ length: 10 }, (_, i) => ({ resourceUrl: `https://s${i}.other${i}.test/x`, medianLatencyMs: 200 })),
  ];
  const e = estimateReprobeSeconds(targets, { concurrency: 16, intervalMs: 1000 });
  assert.deepEqual(e.byDomain[0], ["big.example", 90]);
  assert.equal(e.seconds, 90);
  // 応答が間隔より遅ければ応答時間で数える
  const slow = estimateReprobeSeconds(targets.map((t) => ({ ...t, medianLatencyMs: 2000 })), { concurrency: 16, intervalMs: 1000 });
  assert.equal(slow.seconds, 180);
});
