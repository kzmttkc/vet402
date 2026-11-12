// ============================================================
// 第 1 波 3.4 争いの窓口（P2）と E6（DB なし。npm test で走る）。
// 合格テストの文: ~/Takeshi_Automation/output/1110/factory/specs_3.7_3.8_9a_3.4.md の 3.4。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";

/** 工程 1 で固定した争い画面のパス（/dashboard/disputes ではない）。 */
export const P2_DISPUTE_PAGE_PATH = "/connect/trade-dispute";

const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;/;

async function entry<T>(path: string): Promise<T> {
  try {
    return (await import(path)) as T;
  } catch (error) {
    assert.fail(`entry missing: ${path} (${(error as Error).message.split("\n")[0]})`);
  }
}

test("[fix] 3.4: dispute page path constant matches the connect route", async () => {
  const page = `src/app${P2_DISPUTE_PAGE_PATH}/page.tsx`;
  const src = readFileSync(page, "utf8");
  assert.match(src, /TradeDispute|trade-dispute/);
  assert.doesNotMatch(src, /dashboard\/disputes/);
});

test("[fix] 3.4-E6-1: one side can be stored while the other stays empty without copying", async () => {
  const { mergeE6Record, emptyPayerLeg, emptySellerLeg, hashDeliveredBody } = await entry<
    typeof import("@/lib/observatory/e6-record")
  >("@/lib/observatory/e6-record");
  const id = "p2-e6-1";
  const payerOnly = mergeE6Record(null, {
    purchaseId: id,
    payer: { paymentTx: "0xabc", receivedBodyHash: hashDeliveredBody('{"ok":true}'), state: "settled" },
    seller: emptySellerLeg(),
  });
  assert.equal(payerOnly.payer.paymentTx, "0xabc");
  assert.equal(payerOnly.seller.paymentVerified, null);
  assert.equal(payerOnly.seller.deliveredBodyHash, null);
  assert.equal(payerOnly.seller.deliverySignature, null);

  const sellerOnly = mergeE6Record(null, {
    purchaseId: id,
    payer: emptyPayerLeg(),
    seller: {
      paymentVerified: "0xabc",
      deliveredBodyHash: hashDeliveredBody("payload"),
      deliverySignature: "0x" + "a".repeat(130),
    },
  });
  assert.equal(sellerOnly.payer.paymentTx, null);
  assert.equal(sellerOnly.seller.deliveredBodyHash, hashDeliveredBody("payload"));
});

test("[fix] 3.4-E6-2: matching hashes and both signatures confirm delivery", async () => {
  const { mergeE6Record, hashDeliveredBody, e6DeliveryConfirmed, e6AnchorVerifyLine } = await entry<
    typeof import("@/lib/observatory/e6-record")
  >("@/lib/observatory/e6-record");
  const { e6DayRootHash, e6LineMatchesDayRoot } = await entry<typeof import("@/lib/observatory/e6-anchors")>(
    "@/lib/observatory/e6-anchors",
  );
  const body = '{"answer":1}';
  const h = hashDeliveredBody(body);
  const rec = mergeE6Record(null, {
    purchaseId: "p2-e6-2",
    payer: { paymentTx: "0x1", receivedBodyHash: h, state: "settled", payerSignature: "0x" + "b".repeat(130) },
    seller: {
      paymentVerified: "0x1",
      deliveredBodyHash: h,
      deliverySignature: "0x" + "c".repeat(130),
    },
  });
  assert.equal(e6DeliveryConfirmed(rec), true);
  const line = e6AnchorVerifyLine(rec);
  assert.equal(typeof line.sha256, "string");
  assert.equal(line.sha256.length, 64);
  assert.equal(e6AnchorVerifyLine(rec).sha256, line.sha256);
  const day = rec.updatedAt.slice(0, 10);
  const root = e6DayRootHash("genesis", day, [rec]);
  assert.equal(root.length, 64);
  assert.equal(e6LineMatchesDayRoot(root, "genesis", day, [rec], rec), true);
  assert.equal(e6LineMatchesDayRoot("f".repeat(64), "genesis", day, [rec], rec), false);

  const recAlt = mergeE6Record(rec, {
    purchaseId: "p2-e6-2",
    payer: { paymentTx: "0x2" },
  });
  const dayAlt = recAlt.updatedAt.slice(0, 10);
  const rootAlt = e6DayRootHash("genesis", dayAlt, [recAlt]);
  assert.notEqual(rootAlt, root);
  assert.equal(e6LineMatchesDayRoot(rootAlt, "genesis", dayAlt, [recAlt], recAlt), true);
});

test("[fix] 3.4-E6-2: seller signature alone does not confirm delivery", async () => {
  const { mergeE6Record, hashDeliveredBody, e6DeliveryConfirmed } = await entry<
    typeof import("@/lib/observatory/e6-record")
  >("@/lib/observatory/e6-record");
  const h = hashDeliveredBody("payload");
  const rec = mergeE6Record(null, {
    purchaseId: "p2-e6-2b",
    payer: { paymentTx: "0x1", receivedBodyHash: h, state: "settled", payerSignature: null },
    seller: {
      paymentVerified: "0x1",
      deliveredBodyHash: h,
      deliverySignature: "0x" + "c".repeat(130),
    },
  });
  assert.equal(e6DeliveryConfirmed(rec), false);
});

test("[fix] 3.4-P2-1: seller did not deliver → public stage not_delivered, no body in JSON", async () => {
  const { mergeE6Record, emptySellerLeg } = await entry<typeof import("@/lib/observatory/e6-record")>(
    "@/lib/observatory/e6-record",
  );
  const { publicTradeDisputeJson } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const rec = mergeE6Record(null, {
    purchaseId: "p2-1",
    payer: { paymentTx: "0xpay", receivedBodyHash: null, state: "settled" },
    seller: emptySellerLeg(),
  });
  const pub = publicTradeDisputeJson(rec, { viewer: "anonymous" });
  assert.equal(pub.stage, "not_delivered");
  assert.equal(pub.deliveryConfirmed, false);
  assert.equal("body" in pub, false);
  assert.equal("headers" in pub, false);
  const raw = JSON.stringify(pub);
  assert.doesNotMatch(raw, /"body"/);
  assert.doesNotMatch(raw, /"header/i);
});

test("[fix] 3.4-P2-2: no payment → not_paid", async () => {
  const { mergeE6Record } = await entry<typeof import("@/lib/observatory/e6-record")>("@/lib/observatory/e6-record");
  const { publicTradeDisputeJson } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const rec = mergeE6Record(null, {
    purchaseId: "p2-2",
    payer: { paymentTx: null, receivedBodyHash: null, state: null },
    seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
  });
  const pub = publicTradeDisputeJson(rec, { viewer: "anonymous" });
  assert.equal(pub.stage, "not_paid");
  assert.equal(pub.payer.paymentTx, null);
});

test("[fix] 3.4-P2-4: buyer claims not delivered but hashes and signatures still confirm", async () => {
  const { mergeE6Record, hashDeliveredBody, e6DeliveryConfirmed } = await entry<
    typeof import("@/lib/observatory/e6-record")
  >("@/lib/observatory/e6-record");
  const { publicTradeDisputeJson } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const h = hashDeliveredBody("delivered-body");
  const rec = mergeE6Record(null, {
    purchaseId: "p2-4",
    payer: {
      paymentTx: "0x1",
      receivedBodyHash: h,
      state: "claims_not_delivered",
      payerSignature: "0x" + "f".repeat(130),
    },
    seller: {
      paymentVerified: "0x1",
      deliveredBodyHash: h,
      deliverySignature: "0x" + "e".repeat(130),
    },
  });
  assert.equal(e6DeliveryConfirmed(rec), true);
  const pub = publicTradeDisputeJson(rec, { viewer: "anonymous" });
  assert.notEqual(pub.stage, "not_delivered");
  assert.equal(pub.deliveryConfirmed, true);
  assert.doesNotMatch(JSON.stringify(pub), /"body"/);
  assert.doesNotMatch(JSON.stringify(pub), /\brefund\b|\binconclusive\b/);
});

test("[fix] 3.4-P2-3: mismatched hashes → content_changed, not confirmed", async () => {
  const { mergeE6Record, hashDeliveredBody, e6DeliveryConfirmed } = await entry<
    typeof import("@/lib/observatory/e6-record")
  >("@/lib/observatory/e6-record");
  const { publicTradeDisputeJson } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const rec = mergeE6Record(null, {
    purchaseId: "p2-3",
    payer: { paymentTx: "0x1", receivedBodyHash: hashDeliveredBody("a"), state: "settled" },
    seller: { paymentVerified: "0x1", deliveredBodyHash: hashDeliveredBody("b"), deliverySignature: "0x" + "d".repeat(130) },
  });
  assert.equal(e6DeliveryConfirmed(rec), false);
  const pub = publicTradeDisputeJson(rec, { viewer: "anonymous" });
  assert.equal(pub.stage, "content_changed");
});

test("[fix] 3.4-P2-5: payer through vet402 only leaves seller empty on screen", async () => {
  const { mergeE6Record, hashDeliveredBody } = await entry<typeof import("@/lib/observatory/e6-record")>(
    "@/lib/observatory/e6-record",
  );
  const { partyTradeDisputeView } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const rec = mergeE6Record(null, {
    purchaseId: "p2-5",
    payer: { paymentTx: "0x1", receivedBodyHash: hashDeliveredBody("x"), state: "settled", vet402Relay: true },
    seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null, vet402Middleware: false },
  });
  const view = partyTradeDisputeView(rec, "payer", { ok: false, reason: "unverified" });
  assert.equal(view.payer.vet402Relay, true);
  assert.equal(view.seller.empty, true);
  assert.equal(view.seller.vet402Middleware, false);
});

test("[fix] 3.4-P2-5: seller through vet402 only leaves payer empty on screen", async () => {
  const { mergeE6Record, hashDeliveredBody } = await entry<typeof import("@/lib/observatory/e6-record")>(
    "@/lib/observatory/e6-record",
  );
  const { partyTradeDisputeView } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const h = hashDeliveredBody("seller-only");
  const rec = mergeE6Record(null, {
    purchaseId: "p2-5b",
    payer: { paymentTx: null, receivedBodyHash: null, state: null, vet402Relay: false },
    seller: {
      paymentVerified: "0x1",
      deliveredBodyHash: h,
      deliverySignature: "0x" + "a".repeat(130),
      vet402Middleware: true,
    },
  });
  const view = partyTradeDisputeView(rec, "seller", { ok: false, reason: "unverified" });
  assert.equal(view.payer.empty, true);
  assert.equal(view.seller.vet402Middleware, true);
  assert.equal(view.seller.empty, false);
});

test("[fix] 3.4-P2-6: anonymous viewers get stage only, parties see own proof not the other body", async () => {
  const { mergeE6Record, hashDeliveredBody } = await entry<typeof import("@/lib/observatory/e6-record")>(
    "@/lib/observatory/e6-record",
  );
  const { publicTradeDisputeJson, partyTradeDisputeView } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const { p2PartyAccessMessage, verifyP2PartyAccess } = await entry<typeof import("@/lib/observatory/p2-party-verify")>(
    "@/lib/observatory/p2-party-verify",
  );
  const h = hashDeliveredBody("secret");
  const rec = mergeE6Record(null, {
    purchaseId: "p2-6",
    payer: {
      paymentTx: "0x1",
      receivedBodyHash: h,
      state: "settled",
      payerSignature: "0x" + "b".repeat(130),
    },
    seller: { paymentVerified: "0x1", deliveredBodyHash: h, deliverySignature: "0x" + "e".repeat(130) },
  });
  const anon = publicTradeDisputeJson(rec, { viewer: "anonymous" });
  assert.equal(anon.deliveryConfirmed, true);
  assert.equal("receivedBody" in anon, false);
  const unverified = partyTradeDisputeView(rec, "payer", { ok: false, reason: "unverified" });
  assert.equal(unverified.self.receivedBodyHash, undefined);
  const account = privateKeyToAccount(
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  const issued = new Date().toISOString();
  const message = p2PartyAccessMessage({ purchaseId: rec.purchaseId, party: "payer", issued });
  const signature = await account.signMessage({ message });
  const verification = await verifyP2PartyAccess("payer", rec.purchaseId, {
    kind: "payto_signature",
    wallet: account.address,
    signature,
    issued,
  }, { payerWallet: account.address, sellerPayTo: "0x0000000000000000000000000000000000000001" });
  assert.equal(verification.ok, true);
  const payer = partyTradeDisputeView(rec, "payer", verification);
  assert.equal(payer.self.receivedBodyHash, h);
  assert.equal(payer.other.receivedBodyHash, undefined);
  assert.equal(payer.other.deliveredBodyHash, undefined);
  const dns = await verifyP2PartyAccess(
    "seller",
    rec.purchaseId,
    { kind: "host_dns_txt", host: "seller.example", txt: "v=vet402" },
    { payerWallet: account.address, sellerPayTo: "0x0000000000000000000000000000000000000001" },
  );
  assert.equal(dns.ok, false);
  assert.equal(dns.reason, "dns_txt_not_implemented");
});

test("[fix] 3.4-P2-7: P2 is draft while public Base Sepolia 9a-2 is not green", async () => {
  const { isP2LiveComplete, p2PageMode } = await entry<typeof import("@/lib/observatory/p2-live")>(
    "@/lib/observatory/p2-live",
  );
  assert.equal(isP2LiveComplete(), false);
  assert.equal(p2PageMode(), "draft");
  const page = readFileSync(`src/app${P2_DISPUTE_PAGE_PATH}/page.tsx`, "utf8");
  assert.doesNotMatch(page, /\bLive\b.*dispute/i);
  assert.match(page, /Coming|draft/i);
});

test("[fix] 3.4: draft mode hides e4Outcome on public JSON", async () => {
  const { mergeE6Record } = await entry<typeof import("@/lib/observatory/e6-record")>("@/lib/observatory/e6-record");
  const { publicTradeDisputeJson } = await entry<typeof import("@/lib/observatory/trade-dispute")>(
    "@/lib/observatory/trade-dispute",
  );
  const rec = mergeE6Record(null, {
    purchaseId: "p2-draft-outcome",
    payer: { paymentTx: null, receivedBodyHash: null, state: null },
    seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
  });
  const pub = publicTradeDisputeJson(rec, { viewer: "anonymous" });
  assert.equal(pub.p2Live, false);
  assert.equal(pub.e4Outcome, null);
});

test("[fix] 3.4: demo purchase loads from the default E6 store", async () => {
  const { GET } = await entry<{ GET: (req: NextRequest) => Promise<Response> }>(
    "@/app/api/v1/observatory/disputes/route",
  );
  const { E6_DEMO_PURCHASE_ID, setE6StoreForTests } = await entry<typeof import("@/lib/observatory/e6-store")>(
    "@/lib/observatory/e6-store",
  );
  setE6StoreForTests(null);
  const res = await GET(
    new NextRequest(
      `http://localhost/api/v1/observatory/disputes?purchaseId=${encodeURIComponent(E6_DEMO_PURCHASE_ID)}`,
    ),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.purchaseId, E6_DEMO_PURCHASE_ID);
  assert.equal(body.stage, "not_delivered");
});

test("[fix] 3.4: GET disputes?purchaseId= returns public JSON without measurement dispute fields", async () => {
  const { GET } = await entry<{ GET: (req: NextRequest) => Promise<Response> }>(
    "@/app/api/v1/observatory/disputes/route",
  );
  const { memoryE6Store, setE6StoreForTests } = await entry<typeof import("@/lib/observatory/e6-store")>(
    "@/lib/observatory/e6-store",
  );
  const { mergeE6Record } = await entry<typeof import("@/lib/observatory/e6-record")>("@/lib/observatory/e6-record");
  const store = memoryE6Store();
  setE6StoreForTests(store);
  const rec = mergeE6Record(null, {
    purchaseId: "api-p2-1",
    payer: { paymentTx: null, receivedBodyHash: null, state: null },
    seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
  });
  await store.put(rec);
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/disputes?purchaseId=api-p2-1"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.purchaseId, "api-p2-1");
  assert.equal(body.stage, "not_paid");
  assert.equal(body.remeasureVerdict, undefined);
  setE6StoreForTests(null);
});

test("[fix] 3.4: public English on the dispute page follows I/vet402 rules", () => {
  const page = readFileSync(`src/app${P2_DISPUTE_PAGE_PATH}/page.tsx`, "utf8");
  const lines = page.match(/"[A-Za-z][^"]{8,}"/g) ?? [];
  for (const line of lines) {
    assert.doesNotMatch(line, FORBIDDEN_PUBLIC_ENGLISH, line);
  }
});
