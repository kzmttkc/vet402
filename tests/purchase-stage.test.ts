// ============================================================
// B1 purchase lifecycle stages (unit).
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { e6PublicStage, emptyPayerLeg, emptySellerLeg, type E6Record } from "@/lib/observatory/e6-record";
import { e4OutcomeForStage } from "@/lib/observatory/trade-dispute";
import { OBSERVATORY_VOCABULARY } from "@/lib/observatory/vocabulary";
import { GATEWAY_NOT_CHARGED_EXPIRED } from "@/lib/observatory/arc-gateway-words";
import { PAYER_UNFUNDED_WINDOWS } from "@/lib/observatory/delivery";
import {
  attachPurchaseStageFields,
  HTTP_402_STAGE_STATUSES,
  NOT_DELIVERED_STAGE,
  INCONCLUSIVE_STAGE,
  PURCHASE_STAGES,
  PURCHASE_STAGE_OUTSIDE,
  countPurchaseStages,
  emptyPurchaseLifecycle,
  purchaseStageOf,
  purchaseStageSql,
  STAGE_DEFINITIONS,
} from "@/lib/observatory/purchase-stage";

const row = (partial: {
  status: string;
  httpStatusPaid?: number | null;
  txHash?: string | null;
  authNonce?: string | null;
  attemptedAt?: string;
  network?: string;
  payloadNonEmpty?: boolean | null;
}) => ({
  status: partial.status,
  httpStatusPaid: partial.httpStatusPaid ?? null,
  txHash: partial.txHash ?? null,
  authNonce: partial.authNonce ?? null,
  attemptedAt: partial.attemptedAt ?? "2026-09-10T00:00:00Z",
  network: partial.network ?? "eip155:8453",
  payloadNonEmpty: partial.payloadNonEmpty,
});

test("rule a: revoked when settled correction exists and status is not settled", () => {
  assert.equal(purchaseStageOf(row({ status: "settle_claim_refuted" }), "2026-11-01T12:00:00Z"), "revoked");
  assert.equal(purchaseStageOf(row({ status: "settled" }), "2026-11-01T12:00:00Z"), "settled");
});

test("rule b: inconclusive before delivered or not_delivered", () => {
  assert.equal(purchaseStageOf(row({ status: "settled", httpStatusPaid: 400, txHash: "0x1" })), INCONCLUSIVE_STAGE);
  assert.equal(
    purchaseStageOf(row({ status: "settle_failed", httpStatusPaid: 400, txHash: null })),
    INCONCLUSIVE_STAGE,
  );
  assert.equal(
    purchaseStageOf(
      row({ status: "settle_failed", httpStatusPaid: 402, txHash: null, attemptedAt: PAYER_UNFUNDED_WINDOWS[0]!.from }),
    ),
    INCONCLUSIVE_STAGE,
  );
});

test("rule c: delivered", () => {
  assert.equal(
    purchaseStageOf(row({ status: "settled", httpStatusPaid: 200, txHash: "0x1", payloadNonEmpty: true })),
    "delivered",
  );
});

test("rule d: settled vs not_delivered", () => {
  assert.equal(purchaseStageOf(row({ status: "settled", httpStatusPaid: null, txHash: "0x1" })), "settled");
  assert.equal(purchaseStageOf(row({ status: "settled", httpStatusPaid: 202, txHash: "0x1" })), "settled");
  assert.equal(purchaseStageOf(row({ status: "settled", httpStatusPaid: 500, txHash: "0x1" })), NOT_DELIVERED_STAGE);
  assert.equal(purchaseStageOf(row({ status: "settled", httpStatusPaid: 400, txHash: "0x1" })), INCONCLUSIVE_STAGE);
});

test("rule e: settle_claimed family", () => {
  for (const status of ["settle_claimed", "settle_claimed_unverifiable", "settle_claim_refuted"] as const) {
    assert.equal(purchaseStageOf(row({ status, txHash: "0x1", authNonce: "n" })), "settle_claimed");
  }
});

test("rule f: signed statuses and request_error with auth_nonce", () => {
  for (const status of ["settle_failed", "delivered_no_receipt", GATEWAY_NOT_CHARGED_EXPIRED] as const) {
    assert.equal(purchaseStageOf(row({ status, authNonce: "n" })), "signed");
  }
  assert.equal(purchaseStageOf(row({ status: "request_error", authNonce: "nonce" })), "signed");
  assert.equal(purchaseStageOf(row({ status: "request_error" })), "unknown");
  assert.equal(purchaseStageOf(row({ status: "request_error", authNonce: "presign:row-id" })), "unknown");
  assert.equal(purchaseStageOf(row({ status: "request_error", authNonce: "" })), "unknown");
});

test("rule g: http_402 stage statuses", () => {
  for (const status of HTTP_402_STAGE_STATUSES) {
    assert.equal(purchaseStageOf(row({ status })), "http_402", status);
  }
});

test("rule h: no_402 and unknown", () => {
  assert.equal(purchaseStageOf(row({ status: "no_402" })), "no_402");
  assert.equal(purchaseStageOf(row({ status: "in_flight" })), "unknown");
  assert.equal(purchaseStageOf(row({ status: "novel_status" })), "unknown");
});

test("not_delivered matches e6PublicStage for paid not delivered", () => {
  const rec: E6Record = {
    purchaseId: "p",
    payer: { ...emptyPayerLeg(), paymentTx: "0xabc", state: null },
    seller: emptySellerLeg(),
    updatedAt: "2026-01-01T00:00:00Z",
  };
  assert.equal(NOT_DELIVERED_STAGE, e6PublicStage(rec));
});

test("inconclusive stage name matches e4OutcomeForStage", () => {
  assert.equal(e4OutcomeForStage("not_delivered", false), INCONCLUSIVE_STAGE);
  assert.equal(e4OutcomeForStage("content_changed", false), INCONCLUSIVE_STAGE);
});

test("vocabulary carries settle_claimed settled delivered inconclusive", () => {
  const byTerm = new Map(OBSERVATORY_VOCABULARY.map((t) => [t.term, t]));
  for (const term of ["settle_claimed", "settled", "delivered", "inconclusive"] as const) {
    assert.ok(byTerm.has(term), term);
    assert.ok(PURCHASE_STAGES.includes(term), `${term} must be a PURCHASE_STAGES element`);
  }
});

test("state API and record page use the same stage vocabulary", () => {
  const stateRoute = readFileSync(join(process.cwd(), "src/app/api/v1/observatory/state/route.ts"), "utf8");
  assert.ok(!stateRoute.includes("lifecycle"), "lifecycle comes from reader stats spread");
  const recordPage = readFileSync(join(process.cwd(), "src/app/observatory/e/[id]/page.tsx"), "utf8");
  assert.match(recordPage, /Stage: \{p\.stage\}/);
  for (const stage of [...PURCHASE_STAGES, ...PURCHASE_STAGE_OUTSIDE]) {
    assert.equal(recordPage.includes(`'${stage}'`), false, `record page must not hardcode '${stage}'`);
    assert.equal(recordPage.includes(`"${stage}"`), false, `record page must not hardcode "${stage}"`);
  }
});

test("held rows stay inconclusive not delivered settled or not_delivered", () => {
  const samples = [
    row({ status: "settled", httpStatusPaid: 404, txHash: "0x1" }),
    row({ status: "settle_failed", httpStatusPaid: 401, txHash: null }),
    row({
      status: "settle_failed",
      httpStatusPaid: 402,
      txHash: null,
      attemptedAt: "2026-09-14T00:00:00Z",
    }),
  ];
  for (const s of samples) {
  const stage = purchaseStageOf(s);
    assert.equal(stage, INCONCLUSIVE_STAGE);
    assert.notEqual(stage, "delivered");
    assert.notEqual(stage, NOT_DELIVERED_STAGE);
    assert.notEqual(stage, "settled");
  }
  assert.equal(purchaseStageOf(row({ status: "settled", httpStatusPaid: null, txHash: "0x1" })), "settled");
  assert.notEqual(purchaseStageOf(row({ status: "settled", httpStatusPaid: null, txHash: "0x1" })), NOT_DELIVERED_STAGE);
});

test("lifecycle sum invariant in JS counter", () => {
  const rows = [
    row({ status: "no_402" }),
    row({ status: "halted" }),
    row({ status: "settled", httpStatusPaid: 200, txHash: "0x1", payloadNonEmpty: true }),
    row({ status: "in_flight" }),
  ];
  const counts = countPurchaseStages(rows);
  const sum =
    PURCHASE_STAGES.reduce((n, s) => n + counts.stages[s], 0) +
    counts.outsideStages.no_402 +
    counts.outsideStages.unknown;
  assert.equal(sum, counts.total);
  assert.equal(counts.total, rows.length);
});

test("empty lifecycle has zero shape", () => {
  const e = emptyPurchaseLifecycle();
  assert.equal(e.total, 0);
  for (const s of PURCHASE_STAGES) assert.equal(e.stages[s], 0);
});

test("record rows: the stage reads auth_nonce and the public row does not carry it", () => {
  const rows = attachPurchaseStageFields(
    [
      { id: "a", status: "request_error", httpStatusPaid: null, txHash: null, attemptedAt: null, network: null, authNonce: "signed-nonce" },
      { id: "b", status: "request_error", httpStatusPaid: null, txHash: null, attemptedAt: null, network: null, authNonce: "presign:slot" },
    ],
    new Map(),
  );
  assert.equal(rows[0]!.stage, "signed");
  assert.equal(rows[1]!.stage, "unknown");
  for (const r of rows) {
    assert.equal("authNonce" in r, false);
    assert.equal("id" in r, false);
    assert.equal("payloadNonEmpty" in r, false);
  }
});

test("empty 2xx body stays settled like 202, empty 3xx and 5xx stay not_delivered", () => {
  for (const code of [200, 201, 204, 299]) {
    assert.equal(
      purchaseStageOf(row({ status: "settled", httpStatusPaid: code, txHash: "0x1", payloadNonEmpty: false })),
      "settled",
      `empty ${code}`,
    );
  }
  assert.equal(
    purchaseStageOf(row({ status: "settled", httpStatusPaid: 502, txHash: "0x1", payloadNonEmpty: false })),
    NOT_DELIVERED_STAGE,
  );
  assert.equal(
    purchaseStageOf(row({ status: "settled", httpStatusPaid: 307, txHash: "0x1", payloadNonEmpty: false })),
    NOT_DELIVERED_STAGE,
  );
  assert.equal(
    purchaseStageOf(row({ status: "settled", httpStatusPaid: 200, txHash: "0x1", payloadNonEmpty: null })),
    "delivered",
  );
  const settledWhen = purchaseStageSql("p").split("\n").find((l) => l.includes("THEN 'settled'"))!;
  assert.match(settledWhen, /BETWEEN 200 AND 299/, "SQL settled rule takes the whole 2xx range");
});

test("stage definitions: not_delivered names no side, inconclusive does not read not_delivered as the seller's box", () => {
  assert.match(STAGE_DEFINITIONS.not_delivered, /does not say whose side the failure is on/);
  assert.match(STAGE_DEFINITIONS.not_delivered, /empty/);
  assert.match(STAGE_DEFINITIONS.settled, /empty/);
  assert.doesNotMatch(STAGE_DEFINITIONS.inconclusive, /count it as not_delivered/);
  for (const [k, v] of Object.entries(STAGE_DEFINITIONS)) {
    assert.doesNotMatch(v, /\bwe\b|\bour\b|[\u2013\u2014;]/i, k);
  }
});

test("record page Terms in this table defines Stage", () => {
  const recordPage = readFileSync(join(process.cwd(), "src/app/observatory/e/[id]/page.tsx"), "utf8");
  const terms = recordPage.slice(recordPage.indexOf("function RecordTerms("));
  assert.match(terms, /STAGE_DEFINITIONS/, "RecordTerms reads the stage definitions");
  assert.match(terms, /Stage /, "RecordTerms adds a Stage term");
});
