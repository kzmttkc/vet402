// ============================================================
// vet402 の側（money moved）は settled_not_delivered に入れない（2026-10-28 点検）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { l1CountsOf, l1TimelineOf, type PurchaseInput } from "@/lib/decision/seller-facts";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const iso = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const vet402Paid: PurchaseInput = {
  attemptedAt: iso(3),
  status: "settled",
  latencyMs: null,
  httpStatusPaid: 402,
  payloadNonEmpty: null,
  l2Schema: null,
  txHash: null,
  network: "eip155:8453",
  sellerView: { bucket: "vet402", modeKey: "payer_unfunded", held: null, money: "moved", delivered: false },
};

const sellerPaid500: PurchaseInput = {
  attemptedAt: iso(2),
  status: "settled",
  latencyMs: 300,
  httpStatusPaid: 500,
  payloadNonEmpty: true,
  l2Schema: null,
  txHash: "0x" + "b".repeat(64),
  network: "eip155:8453",
  sellerView: { bucket: "seller", modeKey: "server_error_paid", held: null, money: "moved", delivered: false },
};

const delivered: PurchaseInput = {
  attemptedAt: iso(1),
  status: "settled",
  latencyMs: 200,
  httpStatusPaid: 200,
  payloadNonEmpty: true,
  l2Schema: "match",
  txHash: "0x" + "c".repeat(64),
  network: "eip155:8453",
  sellerView: { bucket: "delivered", modeKey: null, held: null, money: "moved", delivered: true },
};

test("l1CountsOf and l1TimelineOf exclude vet402-side money moved from settled_not_delivered", () => {
  const endpoint = { declaredSchema: null, method: "GET" as const, declaredInput: null };
  const purchases = [delivered, sellerPaid500, vet402Paid];
  const counts = l1CountsOf(purchases, endpoint, NOW);
  assert.equal(counts.paid_attempts, 3);
  assert.equal(counts.delivered, 1);
  assert.equal(counts.settled_not_delivered, 1, "only seller-side paid undelivered counts");
  const timeline = l1TimelineOf({ purchases, ...endpoint }, NOW);
  assert.equal(timeline.n_paid_undelivered, 1);
});
