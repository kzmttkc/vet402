// ============================================================
// S1-1 合格表（配達なし・2 UTC 日）: decision と /sellers が同じ固定行で一致し、BLOCK にならない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_USDC_ADDRESS, classifyRow, classifySellerRow, type SellerRowFacts } from "@/lib/sellers/fix-modes";
import { heldReasonOf } from "@/lib/observatory/delivery";
import { assembleSellerFacts, l1NotCountedOf, l1TimelineOf, type PurchaseInput, type SellerFactsInput } from "@/lib/decision/seller-facts";
import { decidePayer, l1BasisOf, type PayerOptions } from "@/lib/decision/rules";

const TXS = [`0x${"a1".repeat(32)}`, `0x${"b2".repeat(32)}`] as const;
const PYDANTIC = `{"detail":[{"type":"missing","loc":["body","query"],"msg":"Field required","input":{}}]}`;
const NOW = Date.parse("2026-10-22T12:00:00Z");

function fixableRow(at: string, tx: string): SellerRowFacts {
  return {
    endpointId: "ep-s1-1-two-day",
    status: "settled",
    httpStatusPaid: 400,
    txHash: tx,
    attemptedAt: at,
    network: "eip155:8453",
    method: "POST",
    meta: {
      requestBody: "declared",
      requestBodySha256: "a".repeat(64),
      requestQuery: "empty",
      bodyHead: PYDANTIC,
    },
    schema: { properties: { input: { properties: { body: { type: "object" } } } } },
    declaredInput: { query: "empty", body: "declared" },
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    amountUnits: "10000",
    payTo: `0x${"11".repeat(20)}`,
    asset: BASE_USDC_ADDRESS,
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    declaresHeaders: false,
    pathTemplate: false,
    listingMaxTimeoutSeconds: 20,
    payloadNonEmpty: false,
  };
}

const ROWS = [
  fixableRow("2026-10-20T12:00:00Z", TXS[0]),
  fixableRow("2026-10-21T15:00:00Z", TXS[1]),
];

test("S1-1: 配達なし 2 UTC 日の固定行 — n_counted と l1_basis が一致、WARN で BLOCK なし", () => {
  for (const r of ROWS) {
    assert.equal(heldReasonOf(r), "settled_4xx");
    const c = classifyRow(r);
    assert.equal(c.mode?.key, "seller_fixable_input");
    assert.equal(c.bucket, "seller");
  }

  const failureDays = ["2026-10-20", "2026-10-21"];
  const purchases: PurchaseInput[] = ROWS.map((r) => {
    const c = classifySellerRow(r, { now: NOW, sellerFailureDays: failureDays });
    const sellerView = { bucket: c.bucket, modeKey: c.mode?.key ?? null, held: c.held, money: c.money, delivered: c.delivered };
    assert.equal(c.bucket, "seller");
    assert.equal(c.mode?.key, "seller_fixable_input");
    return {
      attemptedAt: r.attemptedAt,
      status: r.status,
      latencyMs: 100,
      httpStatusPaid: r.httpStatusPaid,
      payloadNonEmpty: r.payloadNonEmpty ?? null,
      l2Schema: null,
      l2Detail: null,
      bodyHead: typeof r.meta?.bodyHead === "string" ? r.meta.bodyHead : null,
      contentType: "application/json",
      txHash: r.txHash,
      network: r.network,
      requestMeta: r.meta,
      amountUnits: r.amountUnits ?? null,
      payer: r.payer ?? null,
      settlementConfirmed: null,
      authNonce: "present",
      sellerView,
    };
  });

  const input: SellerFactsInput = {
    probes: [{ probedAt: "2026-10-01T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" }],
    purchases,
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: [],
    declaredSchema: ROWS[0].schema ?? null,
    method: "POST",
    declaredInput: ROWS[0].declaredInput ?? null,
    lastAttemptAt: purchases[0].attemptedAt,
    lastSignedAttemptAt: purchases[0].attemptedAt,
    lastDeliveredAt: null,
  };

  const notCounted = l1NotCountedOf(input, NOW);
  const timeline = l1TimelineOf(input, NOW);
  const facts = assembleSellerFacts(input);
  const options: PayerOptions = { l1NotCounted: notCounted, l1Timeline: timeline, now: new Date(NOW) };
  const d = decidePayer(facts, options);
  const basis = l1BasisOf(facts, options);

  assert.notEqual(d.recommendation, "BLOCK", d.reason_codes.join(","));
  assert.equal(d.recommendation, "WARN");
  const counted = purchases.filter((p) => p.sellerView?.bucket === "seller" || p.sellerView?.bucket === "delivered").length;
  assert.equal(basis.n_counted, counted);
  assert.equal(timeline.n_counted, counted);
  assert.equal(timeline.n_paid_undelivered_seller_side_since_delivery, 0, "held の行は isPaidUndelivered に入れない");
  assert.equal(basis.n_paid_undelivered_seller_side_since_last_delivery, 0, "held seller_fixable_input は l1_paid_not_delivered に入れない");
  assert.ok(d.reason_codes.includes("l1_never_delivered") || d.reason_codes.includes("l1_latest_failed"));
});
