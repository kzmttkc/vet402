// ============================================================
// 2026-11-02.3: settlements は決済済みの送金だけで、断られて署名し直した試行を表さない。
// 同じ resource への短い間隔の支払いは、毎分同じ API を使う普通の買い手と区別できない。
// 測れないものを理由に role=payee を BLOCK にしない。数値は facts に事実として残す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decidePayee, DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { REASON_CODES, reasonCodeDocOf } from "@/lib/decision/reason-codes";
import { loadBuyerFacts, shortIntervalPaymentRate } from "@/lib/decision/buyer-facts";
import { DECISION_RULES_TEXT } from "@/lib/decision/rules-text";
import type { BuyerFacts } from "@/lib/decision/types";

const NOW = new Date("2026-11-02T06:00:00Z");
const buyer = (rate: number | null): BuyerFacts => ({
  settled_count_30d: 500,
  unique_payees_30d: 3,
  short_interval_payment_rate: rate,
  retry_burst_rate: rate,
  sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] },
  erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null },
  first_seen: "2026-09-01T00:00:00Z",
  last_seen: "2026-11-02T05:00:00Z",
});

test("版: 2026-11-02.3", () => assert.equal(DECISION_RULES_VERSION, "2026-11-02.3"));

test("短い間隔の支払いの割合は判定を動かさず、理由コードにも出ない", () => {
  for (const rate of [null, 0, 0.3, 0.31, 0.5, 1]) {
    const d = decidePayee(buyer(rate), { now: NOW });
    assert.equal(d.recommendation, "ALLOW", `rate ${rate}`);
    assert.deepEqual(d.reason_codes, ["history_ok"], `rate ${rate}`);
  }
});

test("他の理由の判定は割合に関係なく変わらない", () => {
  const b = buyer(0.9);
  const sybil = decidePayee({ ...b, sybil: { ...b.sybil, multi_agent_owner: true, shared_funder: true } }, { now: NOW });
  assert.equal(sybil.recommendation, "BLOCK");
  assert.deepEqual(sybil.reason_codes, ["sybil_high"]);

  const listed = decidePayee(b, { now: NOW, operatorBlacklist: true });
  assert.equal(listed.recommendation, "BLOCK");
  assert.deepEqual(listed.reason_codes, ["operator_blacklist"]);

  const degraded = decidePayee({ ...b, sybil: { ...b.sybil, unavailable: ["erc8004"] } }, { now: NOW });
  assert.equal(degraded.recommendation, "BLOCK");
  assert.deepEqual(degraded.reason_codes, ["erc8004_unavailable"]);

  const funder = decidePayee({ ...b, sybil: { ...b.sybil, shared_funder: true } }, { now: NOW });
  assert.equal(funder.recommendation, "WARN");
  assert.deepEqual(funder.reason_codes, ["shared_funder"]);

  assert.equal(decidePayee({ ...b, settled_count_30d: 2 }, { now: NOW }).recommendation, "WARN");
  assert.equal(decidePayee({ ...b, first_seen: "2026-11-01T00:00:00Z" }, { now: NOW }).recommendation, "WARN");
});

test("表の retry_burst は引退の行: 効果なし・リトライと断定しない・enum から消さない", () => {
  const row = reasonCodeDocOf("retry_burst");
  assert.ok(row, "古い応答やログを読む呼び手が引けるよう行を残す");
  assert.equal(row.retired, true);
  assert.equal(row.effect, "none");
  assert.doesNotMatch(row.meaning, /30%/);
  assert.doesNotMatch(`${row.meaning} ${row.forPayer}`, /are retry bursts|unusual retry/i);
  const retired = REASON_CODES.filter((r) => r.retired).map((r) => r.code);
  assert.deepEqual(retired, ["retry_burst"]);
});

test("openapi: 新しい名前を説明し、古い名前は同じ値の deprecated、enum に retry_burst を残す", () => {
  const y = readFileSync(join(process.cwd(), "docs/openapi.yaml"), "utf8");
  const at = y.indexOf("    BuyerFacts:\n");
  const block = y.slice(at, y.indexOf("        sybil:\n", at));
  assert.match(block, /required: \[[^\]]*short_interval_payment_rate[^\]]*retry_burst_rate/);
  const fresh = block.slice(block.indexOf("short_interval_payment_rate:"), block.indexOf("retry_burst_rate:"));
  assert.match(fresh, /same resource/);
  assert.match(fresh, /60 s/);
  assert.doesNotMatch(fresh, /retr(y|ies)|re-sign/i);
  const old = block.slice(block.indexOf("retry_burst_rate:"));
  assert.match(old, /deprecated: true/);
  assert.match(old, /short_interval_payment_rate/);
  assert.match(y.slice(y.indexOf("DecisionReasonCode:")), /enum: \[[^\]]*\bretry_burst\b/);
});

test("公開の説明: /docs/api と llms.txt は新しい名前を説明し、/corrections は版と読み取りの時刻を書く", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const docs = read("src/app/docs/api/page.tsx");
  assert.match(docs, /facts\.short_interval_payment_rate/);
  assert.match(docs, /does not\s+change the verdict/);
  const llms = read("public/llms.txt");
  assert.match(llms, /`facts\.short_interval_payment_rate`/);
  assert.match(llms, /`retry_burst_rate` is its former name/);
  const fixed = read("src/app/corrections/page.tsx");
  assert.match(fixed, /decision rules 2026-11-02\.3/);
  assert.match(fixed, /Read on 2026-11-02T09:01Z/);
});

test("公開の規則の文は版を名乗る（llms.txt・MCP が同じ文を読む）", () => {
  assert.match(DECISION_RULES_TEXT, /Rules 2026-11-02\.3 /);
});

test("純関数は定義どおり: 同じ resource の 60 秒以内の間隔の割合", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s));
  assert.equal(shortIntervalPaymentRate([]), null);
  assert.equal(shortIntervalPaymentRate([{ resourceId: "a", at: at(0) }]), null);
  assert.equal(
    shortIntervalPaymentRate([
      { resourceId: "a", at: at(0) },
      { resourceId: "a", at: at(60) },
      { resourceId: "a", at: at(121) },
      { resourceId: "b", at: at(1) },
    ]),
    1 / 2,
  );
});

test("DB なしの facts: 2 つの名前は同じ null", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const f = await loadBuyerFacts("eip155:8453:0x0000000000000000000000000000000000000001");
    assert.equal(f.short_interval_payment_rate, null);
    assert.equal(f.retry_burst_rate, null);
    assert.deepEqual(f.sybil.unavailable, ["settlements"]);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});
