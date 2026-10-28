// ============================================================
// l1SettledNotDeliveredCount と l1TimelineOf / assemble の一致（2026-10-28 点検 3 回目）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleSellerFacts,
  l1CountsOf,
  l1SettledNotDeliveredCount,
  l1TimelineOf,
  type PurchaseInput,
  type SellerFactsInput,
} from "@/lib/decision/seller-facts";

const decl = { declaredSchema: null, method: "GET", declaredInput: null };

function row(o: Partial<PurchaseInput> & Pick<PurchaseInput, "status" | "attemptedAt">): PurchaseInput {
  return {
    attemptedAt: o.attemptedAt,
    status: o.status,
    latencyMs: null,
    httpStatusPaid: o.httpStatusPaid ?? 500,
    payloadNonEmpty: o.payloadNonEmpty ?? false,
    l2Schema: null,
    txHash: o.txHash ?? "0x1",
    network: "eip155:8453",
    sellerView: o.sellerView ?? null,
  };
}

test("l1SettledNotDeliveredCount matches l1TimelineOf.n_paid_undelivered", () => {
  const input: Pick<SellerFactsInput, "purchases" | "declaredSchema" | "method" | "declaredInput"> = {
    purchases: [
      row({
        attemptedAt: "2026-09-12T00:00:00Z",
        status: "settled",
        sellerView: { bucket: "unsorted", modeKey: null, held: null, money: "moved", delivered: false },
      }),
      row({
        attemptedAt: "2026-09-10T00:00:00Z",
        status: "settled",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        sellerView: { bucket: "delivered", modeKey: null, held: null, money: "moved", delivered: true },
      }),
    ],
    ...decl,
  };
  const now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(l1SettledNotDeliveredCount(input, now), l1TimelineOf(input, now).n_paid_undelivered);
  assert.equal(l1CountsOf(input.purchases, decl, now).settled_not_delivered, l1SettledNotDeliveredCount(input, now));
});

test("assembleSellerFacts with precomputed timeline matches facts without double timeline drift", () => {
  const input: SellerFactsInput = {
    probes: [],
    purchases: [
      row({
        attemptedAt: "2026-09-14T00:00:00Z",
        status: "settled",
        sellerView: { bucket: "seller", modeKey: "server_error_paid", held: null, money: "moved", delivered: false },
      }),
    ],
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: [],
    ...decl,
    lastAttemptAt: "2026-09-14T00:00:00Z",
    lastSignedAttemptAt: "2026-09-14T00:00:00Z",
    lastDeliveredAt: null,
  };
  const now = Date.parse("2026-10-01T00:00:00Z");
  const timeline = l1TimelineOf(input, now);
  const withTimeline = assembleSellerFacts(input, { l1Timeline: timeline });
  const baseline = assembleSellerFacts(input);
  assert.deepEqual(withTimeline.l1, baseline.l1);
});
