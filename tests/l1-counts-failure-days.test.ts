// ============================================================
// failure days の有無で feed の 3 件数が変わらない（2026-10-28 点検 3 回目・純関数）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { l1CountsOf, type PurchaseInput } from "@/lib/decision/seller-facts";
import { ONCE_SUFFIX } from "@/lib/sellers/fix-modes";

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

test("l1CountsOf: seller once (unsorted side) counts same with or without external failure days on timeline input", () => {
  const day1 = "2026-09-10T00:00:00Z";
  const day2 = "2026-09-11T00:00:00Z";
  const onceView = {
    bucket: "unsorted" as const,
    modeKey: `server_error_paid${ONCE_SUFFIX}`,
    held: null,
    money: "moved" as const,
    delivered: false,
  };
  const confirmedView = {
    bucket: "seller" as const,
    modeKey: "server_error_paid",
    held: null,
    money: "moved" as const,
    delivered: false,
  };
  const purchasesOnce: PurchaseInput[] = [
    row({ attemptedAt: day2, status: "settled", sellerView: onceView }),
    row({ attemptedAt: day1, status: "settled", sellerView: onceView }),
  ];
  const purchasesConfirmed: PurchaseInput[] = [
    row({ attemptedAt: day2, status: "settled", sellerView: confirmedView }),
    row({ attemptedAt: day1, status: "settled", sellerView: confirmedView }),
  ];
  const a = l1CountsOf(purchasesOnce, decl);
  const b = l1CountsOf(purchasesConfirmed, decl);
  assert.deepEqual(a, b);
  assert.equal(a.paid_attempts, 2);
  assert.equal(a.delivered, 0);
  assert.equal(a.settled_not_delivered, 2);
});

test("l1CountsOf: vet402 bucket never adds to settled_not_delivered", () => {
  const vet402 = {
    bucket: "vet402" as const,
    modeKey: "payer_unfunded",
    held: null,
    money: "moved" as const,
    delivered: false,
  };
  const purchases: PurchaseInput[] = [
    row({ attemptedAt: "2026-09-14T00:00:00Z", status: "settle_failed", httpStatusPaid: 402, txHash: null, sellerView: vet402 }),
    row({ attemptedAt: "2026-09-13T00:00:00Z", status: "settled", httpStatusPaid: 200, payloadNonEmpty: true, sellerView: { bucket: "delivered", modeKey: null, held: null, money: "moved", delivered: true } }),
  ];
  const c = l1CountsOf(purchases, decl);
  assert.equal(c.delivered, 1);
  assert.equal(c.paid_attempts, 2);
  assert.equal(c.settled_not_delivered, 0);
});
