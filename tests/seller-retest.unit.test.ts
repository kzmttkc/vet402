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
  const pending2 = pendingSellerRetestRequests([{ ...req, id: "b", expiresOn: "2027-01-01" }], new Set(), "2026-10-30", new Set(), 10);
  assert.equal(pending2.length, 1);
});

const BLOCKSCOUT_CELO_ID = "blockscout-2026-11-12-celo-addresses";
const BLOCKSCOUT_PAY_TO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
const BLOCKSCOUT_NOTE =
  "Prezenti M3 のための Celo の1回。売り手の依頼ではない。402 は 2026-11-12 14:3x JST に読んで照合（accepts は Celo・Arc・Base の3つ）";

test("blockscout celo request is on the seller retest list and Base requests stay Base", async () => {
  const { readFileSync } = await import("node:fs");
  const { SELLER_RETEST_REQUESTS } = await import("@/lib/observatory/seller-retest-requests");
  const { BASE_CAIP2, CELO_CAIP2, CELO_USDC } = await import("@/lib/observatory/x402-payer");
  const src = readFileSync(new URL("../src/lib/observatory/seller-retest-requests.ts", import.meta.url), "utf8");
  assert.equal(src.includes(BLOCKSCOUT_NOTE), true);
  assert.equal(CELO_USDC, "0xcebA9300f2b948710d2653dD7B07f33A8B32118C");
  const req = SELLER_RETEST_REQUESTS.find((r) => r.id === BLOCKSCOUT_CELO_ID);
  assert.ok(req);
  assert.equal(req?.requestedOn, "2026-11-12");
  assert.equal(req?.sellerDomain, "api.blockscout.com");
  assert.equal(req?.url, "https://api.blockscout.com/42220/api/v2/addresses");
  assert.equal(req?.method, "GET");
  assert.equal(req?.network, CELO_CAIP2);
  assert.equal(req?.network, "eip155:42220");
  assert.equal(req?.payTo, BLOCKSCOUT_PAY_TO);
  assert.equal(req?.amountUnits, "2000");
  assert.equal(req?.expiresOn, "2026-12-12");
  assert.equal(req?.body, undefined);
  const baseIds = [
    "goldsky-2026-10-30-evm-rpc",
    "goldsky-2026-10-30-feeds-wallets-balances",
    "lupapago-2026-11-10-fx-ar",
  ];
  for (const id of baseIds) {
    const row = SELLER_RETEST_REQUESTS.find((r) => r.id === id);
    assert.equal(row?.network, BASE_CAIP2, id);
  }
  const celoIds = SELLER_RETEST_REQUESTS.filter((r) => r.network === CELO_CAIP2).map((r) => r.id).sort();
  assert.deepEqual(celoIds, [
    "agent-embassy-2026-11-12-celo-verify",
    "blockscout-2026-11-12-celo-addresses",
    "open-rails-2026-11-12-celo-block",
    "paycrawl-2026-11-12-celo-article",
  ]);
  for (const row of SELLER_RETEST_REQUESTS.filter((r) => r.network === CELO_CAIP2)) {
    assert.ok(BigInt(row.amountUnits ?? "0") <= 2000n, row.id);
    assert.equal(row.expiresOn, "2026-12-12", row.id);
  }
});

test("celo seller request selects the Celo USDC accept among Celo, Arc, and Base", async () => {
  const { sellerRequestAccepts, sellerRequestGateOf, validateSellerRequest402 } = await import("@/lib/observatory/seller-retest");
  const { ARC_CAIP2, ARC_USDC, BASE_CAIP2, BASE_USDC, CELO_CAIP2, CELO_USDC, encodePaymentHeader } = await import(
    "@/lib/observatory/x402-payer"
  );
  const { challengeEvidenceForRow, paymentPayloadEvidence, x402ChallengeEvidence } = await import(
    "@/lib/observatory/purchase-evidence"
  );
  const gate = sellerRequestGateOf({
    id: BLOCKSCOUT_CELO_ID,
    requestedOn: "2026-11-12",
    sellerDomain: "api.blockscout.com",
    url: "https://api.blockscout.com/42220/api/v2/addresses",
    method: "GET",
    network: CELO_CAIP2,
    payTo: BLOCKSCOUT_PAY_TO,
    expiresOn: "2026-12-12",
    amountUnits: "2000",
  });
  const wrongAsset = {
    scheme: "exact",
    network: CELO_CAIP2,
    amount: "2000",
    asset: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    payTo: BLOCKSCOUT_PAY_TO,
  };
  const arc = { scheme: "exact", network: ARC_CAIP2, amount: "2000", asset: ARC_USDC, payTo: BLOCKSCOUT_PAY_TO };
  const base = {
    scheme: "exact",
    network: BASE_CAIP2,
    amount: "2000",
    asset: BASE_USDC,
    payTo: BLOCKSCOUT_PAY_TO,
    extra: { name: "USD Coin", version: "2" },
  };
  const celo = {
    scheme: "exact",
    network: CELO_CAIP2,
    amount: "2000",
    asset: CELO_USDC,
    payTo: "0x242bA6d68ffeb4a098b591b32d370f973ff882B7",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
  const accepts = [wrongAsset, arc, base, celo];
  const verdict = validateSellerRequest402({ x402Version: 2, accepts }, gate);
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  assert.equal(verdict.amountUnits, 2000n);
  assert.equal(verdict.payTo, celo.payTo);
  assert.equal(verdict.asset?.toLowerCase(), CELO_USDC.toLowerCase());
  const picked = sellerRequestAccepts(accepts, gate);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.network, CELO_CAIP2);
  assert.equal(picked[0]?.asset.toLowerCase(), CELO_USDC.toLowerCase());
  assert.equal(picked[0]?.amount, "2000");
  const onlyWrongAsset = validateSellerRequest402({ x402Version: 2, accepts: [wrongAsset, arc, base] }, gate);
  assert.equal(onlyWrongAsset.ok, false);

  const body = JSON.stringify({ x402Version: 2, accepts });
  const challenge402 = challengeEvidenceForRow(
    x402ChallengeEvidence({
      httpStatus: 402,
      headers: new Headers({ "content-type": "application/json" }),
      bodyText: body,
      selectedAccept: picked[0],
    }),
  );
  const header = encodePaymentHeader({
    x402Version: 2,
    accept: picked[0]!,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: picked[0]!.payTo,
        value: picked[0]!.amount,
        validAfter: "0",
        validBefore: "1",
        nonce: "0x" + "11".repeat(32),
      },
    },
    resourceUrl: "https://api.blockscout.com/42220/api/v2/addresses",
  });
  const paymentPayload = paymentPayloadEvidence(header);
  assert.equal(challenge402.protocol, "x402");
  assert.equal((challenge402.selectedAccept as { network?: string }).network, CELO_CAIP2);
  assert.equal(paymentPayload.headerName, "PAYMENT-SIGNATURE");
  const decoded = paymentPayload.decoded as { accepted?: { network?: string; asset?: string; amount?: string } };
  assert.equal(decoded.accepted?.network, CELO_CAIP2);
  assert.equal(decoded.accepted?.asset?.toLowerCase(), CELO_USDC.toLowerCase());
  assert.equal(decoded.accepted?.amount, "2000");
});

test("celo seller request does not buy when payTo or amount differs", async () => {
  const { sellerRequestAccepts, sellerRequestGateOf, validateSellerRequest402 } = await import("@/lib/observatory/seller-retest");
  const { ARC_CAIP2, ARC_USDC, BASE_CAIP2, BASE_USDC, CELO_CAIP2, CELO_USDC } = await import("@/lib/observatory/x402-payer");
  const gate = sellerRequestGateOf({
    id: BLOCKSCOUT_CELO_ID,
    requestedOn: "2026-11-12",
    sellerDomain: "api.blockscout.com",
    url: "https://api.blockscout.com/42220/api/v2/addresses",
    method: "GET",
    network: CELO_CAIP2,
    payTo: BLOCKSCOUT_PAY_TO,
    expiresOn: "2026-12-12",
    amountUnits: "2000",
  });
  const celo = {
    scheme: "exact" as const,
    network: CELO_CAIP2,
    amount: "2000",
    asset: CELO_USDC,
    payTo: BLOCKSCOUT_PAY_TO,
    extra: { name: "USDC", version: "2" },
  };
  const decoys = [
    { scheme: "exact", network: ARC_CAIP2, amount: "2000", asset: ARC_USDC, payTo: BLOCKSCOUT_PAY_TO },
    { scheme: "exact", network: BASE_CAIP2, amount: "2000", asset: BASE_USDC, payTo: BLOCKSCOUT_PAY_TO },
  ];
  const badPayTo = validateSellerRequest402(
    { x402Version: 2, accepts: [{ ...celo, payTo: "0x0000000000000000000000000000000000000002" }, ...decoys] },
    gate,
  );
  assert.equal(badPayTo.ok, false);
  if (!badPayTo.ok) assert.equal(badPayTo.reason, "seller_request_payto_mismatch");
  assert.equal(
    sellerRequestAccepts([{ ...celo, payTo: "0x0000000000000000000000000000000000000002" }, ...decoys], gate).length,
    0,
  );

  const low = validateSellerRequest402({ x402Version: 2, accepts: [{ ...celo, amount: "1999" }, ...decoys] }, gate);
  assert.equal(low.ok, false);
  assert.equal(sellerRequestAccepts([{ ...celo, amount: "1999" }, ...decoys], gate).length, 0);

  const high = validateSellerRequest402({ x402Version: 2, accepts: [{ ...celo, amount: "2001" }, ...decoys] }, gate);
  assert.equal(high.ok, false);
  assert.equal(sellerRequestAccepts([{ ...celo, amount: "2001" }, ...decoys], gate).length, 0);

  const overCap = validateSellerRequest402({ x402Version: 2, accepts: [{ ...celo, amount: "1000001" }] }, gate);
  assert.equal(overCap.ok, false);
  if (!overCap.ok) assert.equal(overCap.reason, "seller_request_over_cap");
});

test("base seller request keeps the current accept rules", async () => {
  const { sellerRequestAccepts, validateSellerRequest402 } = await import("@/lib/observatory/seller-retest");
  const { BASE_USDC, CELO_CAIP2, CELO_USDC } = await import("@/lib/observatory/x402-payer");
  const gate = {
    id: "t",
    expectedPayTo: "0x87aB362fEF2106d24762289410a18e7c42304C68",
    network: "eip155:8453",
    maxAmountUnits: 5000n,
  };
  const cheaper = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "4000",
    asset: BASE_USDC,
    payTo: gate.expectedPayTo,
    extra: { name: "USD Coin", version: "2" },
  };
  const exact = { ...cheaper, amount: "5000" };
  const celo = {
    scheme: "exact",
    network: CELO_CAIP2,
    amount: "5000",
    asset: CELO_USDC,
    payTo: gate.expectedPayTo,
    extra: { name: "USDC", version: "2" },
  };
  const underCap = validateSellerRequest402({ x402Version: 2, accepts: [celo, cheaper] }, gate);
  assert.equal(underCap.ok, true);
  if (underCap.ok) {
    assert.equal(underCap.amountUnits, 4000n);
    assert.equal(underCap.payTo, gate.expectedPayTo);
  }
  const picked = sellerRequestAccepts([celo, cheaper, exact], gate);
  assert.equal(picked.length, 2);
  assert.ok(picked.every((a) => a.network === "eip155:8453"));
  const badPayTo = validateSellerRequest402(
    { x402Version: 2, accepts: [{ ...exact, payTo: "0x0000000000000000000000000000000000000001" }] },
    gate,
  );
  assert.equal(badPayTo.ok, false);
  if (!badPayTo.ok) assert.equal(badPayTo.reason, "seller_request_payto_mismatch");
});

test("seller request on a network other than Base or Celo is refused", async () => {
  const { sellerRequestAccepts, validateSellerRequest402 } = await import("@/lib/observatory/seller-retest");
  const networks = ["eip155:42161", "eip155:5042", "eip155:56", "eip155:43114", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];
  for (const network of networks) {
    const gate = {
      id: "other",
      expectedPayTo: BLOCKSCOUT_PAY_TO,
      network,
      maxAmountUnits: 2000n,
    };
    const accept = { scheme: "exact", network, amount: "2000", asset: "0x" + "22".repeat(20), payTo: BLOCKSCOUT_PAY_TO };
    const verdict = validateSellerRequest402({ x402Version: 2, accepts: [accept] }, gate);
    assert.equal(verdict.ok, false, network);
    if (!verdict.ok) assert.equal(verdict.reason, "seller_request_network_unsupported", network);
    assert.equal(sellerRequestAccepts([accept], gate).length, 0, network);
  }
});
