// ============================================================
// 売り手依頼リスト — 402 照合（DB 不要）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

test("validateSellerRequest402: payTo / network / cap", async () => {
  const { validateSellerRequest402 } = await import("@/lib/observatory/seller-retest");
  const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
  const gate = {
    id: "t",
    expectedPayTo: "0x87aB362fEF2106d24762289410a18e7c42304C68",
    network: "eip155:8453",
    maxAmountUnits: 5000n,
  };
  const ok = validateSellerRequest402(
    {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "5000",
          asset: BASE_USDC,
          payTo: "0x87aB362fEF2106d24762289410a18e7c42304C68",
        },
      ],
    },
    gate,
  );
  assert.equal(ok.ok, true);

  const badPayTo = validateSellerRequest402(
    {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "5000",
          asset: BASE_USDC,
          payTo: "0x0000000000000000000000000000000000000001",
        },
      ],
    },
    gate,
  );
  assert.equal(badPayTo.ok, false);
  if (!badPayTo.ok) assert.equal(badPayTo.reason, "seller_request_payto_mismatch");

  const noNet = validateSellerRequest402({ x402Version: 2, accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "5000", asset: "x", payTo: gate.expectedPayTo }] }, gate);
  assert.equal(noNet.ok, false);
  if (!noNet.ok) assert.equal(noNet.reason, "seller_request_network_missing");
});

test("pendingSellerRetestRequests: expiry and completion", async () => {
  const { pendingSellerRetestRequests, isSellerRetestRequestActive } = await import("@/lib/observatory/seller-retest");
  const req = {
    id: "a",
    requestedOn: "2026-10-30",
    sellerDomain: "x.example",
    url: "https://x.example/a",
    method: "GET" as const,
    network: "eip155:8453",
    payTo: "0x1",
    expiresOn: "2026-10-29",
  };
  assert.equal(isSellerRetestRequestActive(req, "2026-10-30"), false);
  const pending = pendingSellerRetestRequests([{ ...req, expiresOn: "2027-01-01" }], new Set(["a"]), "2026-10-30");
  assert.equal(pending.length, 0);
  const pending2 = pendingSellerRetestRequests([{ ...req, id: "b", expiresOn: "2027-01-01" }], new Set(), "2026-10-30", 10);
  assert.equal(pending2.length, 1);
});
