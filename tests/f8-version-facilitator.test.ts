// F8: rules_version on public verdict/score paths; l1.byFacilitator shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { DELIVERY_RATE_FORMULA } from "@/lib/delivery/delivery-rate";
import { deliveredRates, L1_DELIVERED_SHARE_FORMULA } from "@/lib/observatory/delivered-rates";
import { withScoreDeprecationBody } from "@/lib/api/score-deprecation";
import { l1FacilitatorIdSql, L1_FACILITATOR_UNKNOWN } from "@/lib/observatory/l1-facilitator";

test("deliveredRates carries ratio-pct1-v1 (simple pct1, not Wilson)", () => {
  const r = deliveredRates({ attempts: 10, delivered: 5, inconclusive: 1, awaitingReread: 0 });
  assert.equal(r.rate_formula, L1_DELIVERED_SHARE_FORMULA);
  assert.equal(r.rate_formula, "ratio-pct1-v1");
  assert.notEqual(r.rate_formula, DELIVERY_RATE_FORMULA);
});

test("deprecated score bodies carry rules_version", () => {
  const body = withScoreDeprecationBody({ trustScore: 1, recommendation: "ALLOW" });
  assert.equal(body.rules_version, DECISION_RULES_VERSION);
});

test("l1FacilitatorIdSql maps unknown EVM rows to unknown", () => {
  const sql = l1FacilitatorIdSql("pu");
  assert.match(sql, new RegExp(L1_FACILITATOR_UNKNOWN));
  assert.match(sql, /circle_gateway/);
});

test("l1FacilitatorIdSql branches xrpl, tempo, stellar; Solana rows map to unknown", () => {
  const sql = l1FacilitatorIdSql("pu");
  assert.match(sql, /network = 'xrpl:0' THEN 'xrpl_t54'/);
  assert.match(sql, /network = 'eip155:4217' THEN 'tempo_mpp'/);
  assert.match(sql, /network = 'stellar:pubnet' THEN 'stellar_facilitator'/);
  assert.doesNotMatch(sql, /feePayer/);
  assert.doesNotMatch(sql, /challenge_402|payment_payload|challenge402/);
  assert.doesNotMatch(sql, /solana:/);
});

test("GET /api/v1/observatory/state exposes l1.byFacilitator and l1Rates.rate_formula", async () => {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.l1?.byFacilitator));
  assert.equal(body.l1Rates?.rate_formula, L1_DELIVERED_SHARE_FORMULA);
  assert.match(String(body.disclaimer), /l1\.byFacilitator/);
  const sumAttempts = body.l1.byFacilitator.reduce((n: number, b: { attempts: number }) => n + b.attempts, 0);
  assert.equal(sumAttempts, body.l1.attempts);
  const unknown = body.l1.byFacilitator.find((b: { facilitator: string }) => b.facilitator === "unknown");
  assert.ok(unknown, "unknown bucket must always be present");
});

test("handleFind includes rules_version and Wilson rate_formula", async () => {
  const { handleFind } = await import("@/lib/find/find-handler");
  const res = await handleFind(new Request("http://localhost/api/v1/find?q=zzznonexistentzzz"), {
    findAlternatives: async () => ({ fetchedAt: new Date().toISOString(), listings: [] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rules_version, DECISION_RULES_VERSION);
  assert.equal(body.rate_formula, DELIVERY_RATE_FORMULA);
});