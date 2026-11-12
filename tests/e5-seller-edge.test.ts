// ============================================================
// ABSORB E5 売り手の端。決済は売り手の facilitator のまま。vet402 は代わりに受けない。
// 偽・使い回し・額の違いは中身を渡さずに止まる。正しい支払いだけ証明を返し E6 に載せる。
// 4xx の保留は売り手の失点にしない。遅れは測った値だけを出し、測らずに 20ms とは書かない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashDeliveredBody } from "@/lib/observatory/e6-record";
import { memoryE6Store } from "@/lib/observatory/e6-store";
import { recordSellerEdgeOnE6 } from "@/lib/seller-edge/record";
import {
  createExpressSellerEdge,
  createHonoSellerEdge,
  createSellerEdge,
  deliveryBodyHash,
  reportSellerEdgeLatency,
  withLambdaEdgeSellerEdge,
  withSellerEdge,
  withWorkerSellerEdge,
  DELIVERY_HASH_HEADER,
  DELIVERY_PROOF_HEADER,
  type ChainTransfer,
  type FacilitatorReceipt,
  type SellerEdge,
  type SellerEdgeConfig,
  type SellerOffer,
} from "../packages/middleware/src/seller.js";

const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;/;
const SECRET = "SECRET_BODY_E5";
const OFFER: SellerOffer = {
  amount: "10000",
  payTo: "0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  network: "eip155:84532",
};
const TX = "0x" + "ab".repeat(32);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function signDelivery(value: string): string {
  return sign(null, Buffer.from(value), privateKey).toString("hex");
}

function chainOf(over: Partial<ChainTransfer> = {}): ChainTransfer {
  return {
    txHash: TX,
    amount: OFFER.amount,
    payTo: OFFER.payTo,
    asset: OFFER.asset,
    network: OFFER.network,
    ...over,
  };
}

function receiptOf(over: Partial<FacilitatorReceipt> = {}): FacilitatorReceipt {
  return {
    valid: true,
    txHash: TX,
    amount: OFFER.amount,
    payTo: OFFER.payTo,
    asset: OFFER.asset,
    network: OFFER.network,
    ...over,
  };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

type Harness = {
  edge: SellerEdge;
  chainCalls: string[];
  records: unknown[];
};

function harness(
  over: Partial<SellerEdgeConfig> & { chain?: ChainTransfer | null; chainImpl?: SellerEdgeConfig["readChain"] } = {},
): Harness {
  const chainCalls: string[] = [];
  const records: unknown[] = [];
  const readChain =
    over.chainImpl ??
    (async (txHash: string) => {
      chainCalls.push(txHash);
      return over.chain === undefined ? chainOf() : over.chain;
    });
  const edge = createSellerEdge({
    offer: over.offer ?? { ...OFFER },
    readChain,
    signDelivery: over.signDelivery ?? signDelivery,
    recordE6:
      over.recordE6 ??
      (async (row) => {
        records.push(row);
      }),
    replay: over.replay,
    clock: over.clock,
  });
  return { edge, chainCalls, records };
}

function okHandler(body = SECRET, status = 200): () => Promise<{ status: number; body: string }> {
  return async () => ({ status, body });
}

test("[fix] E5: seller edge source does not settle, fetch, or share the C1 or 3.9 function", () => {
  const src = readFileSync("packages/middleware/src/seller-edge.ts", "utf8");
  assert.doesNotMatch(src, /fetch\s*\(/);
  assert.doesNotMatch(src, /\/settle/);
  assert.doesNotMatch(src, /x402\.org/);
  assert.doesNotMatch(src, /createTrustGate|wrapFetch|vet402-read-hook/);
  assert.doesNotMatch(src, /viem|x402-pay|pay-or-refuse|signTypedData/);
  const pkg = JSON.parse(readFileSync("packages/middleware/package.json", "utf8")) as {
    exports: Record<string, unknown>;
  };
  assert.ok(pkg.exports["./seller"], "seller subpath is a separate entry");
  const gate = readFileSync("packages/middleware/src/index.ts", "utf8");
  assert.doesNotMatch(gate, /createSellerEdge/);
});

test("[fix] E5: a missing facilitator receipt does not deliver the body", async () => {
  const { edge, chainCalls, records } = harness();
  let calls = 0;
  const result = await edge.run({ purchaseId: "e5-fake-missing", receipt: null }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(chainCalls.length, 0);
  assert.equal(records.length, 0);
  assert.equal(result.delivered, false);
  assert.equal(result.sellerMiss, false);
  assert.equal(result.reason, "payment_fake");
  assert.equal(result.status, 402);
  assert.equal(result.body.includes(SECRET), false);
  assert.equal(header(result.headers, DELIVERY_PROOF_HEADER), undefined);
});

test("[fix] E5: facilitator invalid is fake even when the chain transfer matches", async () => {
  const { edge, chainCalls } = harness();
  let calls = 0;
  const result = await edge.run(
    { purchaseId: "e5-fake-invalid", receipt: receiptOf({ valid: false }) },
    async () => {
      calls += 1;
      return { status: 200, body: SECRET };
    },
  );
  assert.equal(calls, 0);
  assert.equal(chainCalls.length, 0);
  assert.equal(result.reason, "payment_fake");
  assert.equal(result.body.includes(SECRET), false);
  assert.equal(result.sellerMiss, false);
});

test("[fix] E5: a facilitator-valid payment with no chain transfer does not deliver", async () => {
  const { edge, chainCalls, records } = harness({ chain: null });
  let calls = 0;
  const result = await edge.run({ purchaseId: "e5-fake-chain", receipt: receiptOf() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.deepEqual(chainCalls, [TX]);
  assert.equal(records.length, 0);
  assert.equal(result.reason, "payment_fake");
  assert.equal(result.status, 402);
  assert.equal(result.body.includes(SECRET), false);
  assert.equal(result.sellerMiss, false);
});

test("[fix] E5: replaying a delivered tx does not deliver again", async () => {
  const h = harness();
  let calls = 0;
  const handler = async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  };
  const first = await h.edge.run({ purchaseId: "e5-replay-1", receipt: receiptOf() }, handler);
  const second = await h.edge.run({ purchaseId: "e5-replay-2", receipt: receiptOf() }, handler);
  assert.equal(first.delivered, true);
  assert.equal(calls, 1);
  assert.equal(second.delivered, false);
  assert.equal(second.reason, "payment_replay");
  assert.equal(second.status, 409);
  assert.equal(second.body.includes(SECRET), false);
  assert.equal(second.sellerMiss, false);
  assert.equal(h.records.length, 1);
});

test("[fix] E5: a chain amount that differs from the offer does not deliver", async () => {
  const { edge, records } = harness({ chain: chainOf({ amount: "10001" }) });
  let calls = 0;
  const result = await edge.run({ purchaseId: "e5-amount-chain", receipt: receiptOf() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(records.length, 0);
  assert.equal(result.reason, "amount_mismatch");
  assert.equal(result.status, 402);
  assert.equal(result.body.includes(SECRET), false);
  assert.equal(result.sellerMiss, false);
});

test("[fix] E5: a facilitator amount that differs from the offer does not deliver", async () => {
  const { edge, chainCalls } = harness();
  let calls = 0;
  const result = await edge.run(
    { purchaseId: "e5-amount-receipt", receipt: receiptOf({ amount: "010000" }) },
    async () => {
      calls += 1;
      return { status: 200, body: SECRET };
    },
  );
  assert.equal(calls, 0);
  assert.equal(chainCalls.length, 0);
  assert.equal(result.reason, "amount_mismatch");
  assert.equal(result.body.includes(SECRET), false);
});

test("[fix] E5: a chain payTo that differs from the offer does not deliver", async () => {
  const { edge } = harness({
    chain: chainOf({ payTo: "0x1111111111111111111111111111111111111111" }),
  });
  let calls = 0;
  const result = await edge.run({ purchaseId: "e5-dest", receipt: receiptOf() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, "destination_mismatch");
  assert.equal(result.body.includes(SECRET), false);
  assert.equal(result.sellerMiss, false);
});

test("[fix] E5: a correct testnet-shaped payment returns a proof and lands on E6", async () => {
  const store = memoryE6Store();
  const signed: string[] = [];
  const { edge } = harness({
    signDelivery: (value) => {
      signed.push(value);
      return signDelivery(value);
    },
    recordE6: async (row) => {
      await recordSellerEdgeOnE6(row.purchaseId, row.seller, store);
    },
  });
  const result = await edge.run({ purchaseId: "e5-ok-1", receipt: receiptOf() }, okHandler());
  assert.equal(result.delivered, true);
  assert.equal(result.status, 200);
  assert.equal(result.body, SECRET);
  assert.equal(result.sellerMiss, false);
  const bodyHash = header(result.headers, DELIVERY_HASH_HEADER);
  const proof = header(result.headers, DELIVERY_PROOF_HEADER);
  assert.equal(bodyHash, hashDeliveredBody(SECRET));
  assert.equal(bodyHash, deliveryBodyHash(SECRET));
  assert.equal(signed[0], bodyHash);
  assert.equal(verify(null, Buffer.from(bodyHash ?? "", "utf8"), publicKey, Buffer.from(proof ?? "", "hex")), true);
  const saved = await store.get("e5-ok-1");
  assert.ok(saved);
  assert.equal(saved.payer.paymentTx, null);
  assert.equal(saved.seller.paymentVerified, TX);
  assert.equal(saved.seller.deliveredBodyHash, hashDeliveredBody(SECRET));
  assert.equal(saved.seller.deliverySignature, proof);
  assert.equal(saved.seller.vet402Middleware, true);
});

test("[fix] E5: lowercase payTo still matches the offer and a later offer edit does not loosen it", async () => {
  const offer: SellerOffer = { ...OFFER };
  const { edge } = harness({
    offer,
    chain: chainOf({ payTo: OFFER.payTo.toLowerCase() }),
  });
  offer.amount = "1";
  const lowered = await edge.run(
    { purchaseId: "e5-case", receipt: receiptOf({ payTo: OFFER.payTo.toLowerCase() }) },
    okHandler(),
  );
  assert.equal(lowered.delivered, true);
  const loosened = await edge.run(
    { purchaseId: "e5-loosen", receipt: receiptOf({ amount: "1", txHash: "0x" + "cd".repeat(32) }) },
    okHandler(),
  );
  assert.equal(loosened.delivered, false);
  assert.equal(loosened.reason, "amount_mismatch");
});

test("[fix] E5: a 4xx hold after a valid payment is not a seller miss and is not a delivery proof", async () => {
  const { edge, records } = harness();
  const result = await edge.run({ purchaseId: "e5-hold", receipt: receiptOf() }, okHandler('{"error":"bad form"}', 400));
  assert.equal(result.delivered, false);
  assert.equal(result.sellerMiss, false);
  assert.equal(result.status, 400);
  assert.equal(result.body, '{"error":"bad form"}');
  assert.equal(header(result.headers, DELIVERY_PROOF_HEADER), undefined);
  assert.equal(records.length, 0);
  const again = await edge.run({ purchaseId: "e5-hold-retry", receipt: receiptOf() }, okHandler());
  assert.equal(again.delivered, true);
});

test("[fix] E5: a 5xx after a valid payment is a seller miss and carries no delivery proof", async () => {
  const { edge, records } = harness();
  const result = await edge.run({ purchaseId: "e5-5xx", receipt: receiptOf() }, okHandler("down", 500));
  assert.equal(result.delivered, false);
  assert.equal(result.sellerMiss, true);
  assert.equal(result.status, 500);
  assert.equal(header(result.headers, DELIVERY_PROOF_HEADER), undefined);
  assert.equal(records.length, 0);
});

test("[fix] E5: empty 200 is not delivered and 202 is not a miss and not a proof", async () => {
  const emptyEdge = harness();
  const empty = await emptyEdge.edge.run({ purchaseId: "e5-empty", receipt: receiptOf() }, okHandler("", 200));
  assert.equal(empty.delivered, false);
  assert.equal(empty.sellerMiss, true);
  assert.equal(emptyEdge.records.length, 0);
  const accepted = harness();
  const held = await accepted.edge.run(
    { purchaseId: "e5-202", receipt: receiptOf() },
    okHandler('{"state":"processing"}', 202),
  );
  assert.equal(held.delivered, false);
  assert.equal(held.sellerMiss, false);
  assert.equal(held.body, '{"state":"processing"}');
  assert.equal(header(held.headers, DELIVERY_PROOF_HEADER), undefined);
  assert.equal(accepted.records.length, 0);
});

test("[fix] E5: one sample does not claim the 20 ms target", async () => {
  const { edge } = harness({ clock: () => 0 });
  await edge.run({ purchaseId: "e5-lat-1", receipt: null }, okHandler());
  const report = edge.latency();
  assert.equal(report.samples, 1);
  assert.equal(report.measuredP95Ms, null);
  assert.equal(report.targetMet, false);
  assert.match(report.statement, /does not claim the 20 ms target/);
  assert.doesNotMatch(report.statement, FORBIDDEN_PUBLIC_ENGLISH);
});

test("[fix] E5: p95 above 20 ms publishes that value and does not claim the target", () => {
  const samples = Array.from({ length: 20 }, () => 27.5);
  const report = reportSellerEdgeLatency(samples);
  assert.equal(report.measuredP95Ms, 27.5);
  assert.equal(report.targetMet, false);
  assert.equal(report.targetMet, (report.measuredP95Ms ?? 99) <= report.targetP95Ms);
  assert.match(report.statement, /p95 27\.5 ms/);
  assert.match(report.statement, /above the target/);
  assert.doesNotMatch(report.statement, /at or under the target/);
  assert.doesNotMatch(report.statement, FORBIDDEN_PUBLIC_ENGLISH);
});

test("[fix] E5: p95 at or under 20 ms is claimed only from the measured samples", () => {
  const samples = Array.from({ length: 19 }, () => 1).concat(100);
  const report = reportSellerEdgeLatency(samples);
  assert.equal(report.samples, 20);
  assert.equal(report.measuredP95Ms, 1);
  assert.equal(report.targetMet, true);
  assert.match(report.statement, /p95 1 ms over 20 samples/);
  assert.match(report.statement, /at or under the target/);
  assert.doesNotMatch(report.statement, FORBIDDEN_PUBLIC_ENGLISH);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  const wide = reportSellerEdgeLatency(hundred);
  assert.equal(wide.measuredP95Ms, 95);
  assert.equal(wide.targetMet, false);
});

test("[fix] E5: overhead excludes handler time", async () => {
  const stamps = [0, 10, 5000, 5014];
  let i = 0;
  const { edge } = harness({ clock: () => stamps[i++] ?? 5014 });
  let saw = false;
  const result = await edge.run({ purchaseId: "e5-clock", receipt: receiptOf() }, async () => {
    saw = true;
    return { status: 200, body: SECRET };
  });
  assert.equal(saw, true);
  assert.equal(result.delivered, true);
  assert.equal(i, 4);
  assert.deepEqual(edge.latency().overheadMs, [24]);
});

test("[fix] E5: seller README section follows the public English rules and does not state an unmeasured 20 ms", () => {
  const readme = readFileSync("packages/middleware/README.md", "utf8");
  const at = readme.indexOf("## Seller edge");
  assert.ok(at >= 0);
  const section = readme.slice(at);
  assert.doesNotMatch(section, FORBIDDEN_PUBLIC_ENGLISH);
  assert.doesNotMatch(section, /20\s*ms/i);
  assert.match(section, /createExpressSellerEdge/);
  assert.match(section, /createHonoSellerEdge/);
  assert.match(section, /withSellerEdge/);
  assert.match(section, /withWorkerSellerEdge/);
  assert.match(section, /withLambdaEdgeSellerEdge/);
  assert.match(section, /does not settle/);
  assert.match(section, /does not receive/);
  assert.match(section, /Not yet published to npm/);
});

test("[fix] E5: Express one liner withholds a fake payment and proves a real one", async () => {
  const good = createExpressSellerEdge<{ receipt: FacilitatorReceipt | null; purchaseId: string }>({
    offer: { ...OFFER },
    readChain: async () => chainOf(),
    signDelivery,
    recordE6: async () => {},
    getReceipt: (req) => req.receipt,
    getPurchaseId: (req) => req.purchaseId,
  });
  const res = mockRes();
  let nexted = false;
  await good({ receipt: null, purchaseId: "e5-ex-fake" }, res, () => {
    nexted = true;
  });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 402);
  assert.equal(JSON.stringify(res.body).includes(SECRET), false);

  const ok = mockRes();
  await good({ receipt: receiptOf(), purchaseId: "e5-ex-ok" }, ok, () => {
    ok.status(200).json({ secret: SECRET });
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.body as { secret: string }).secret, SECRET);
  assert.equal(typeof ok.headers[DELIVERY_PROOF_HEADER], "string");
  const hashed = createHash("sha256").update(JSON.stringify({ secret: SECRET }), "utf8").digest("hex");
  assert.equal(ok.headers[DELIVERY_HASH_HEADER], hashed);
});

test("[fix] E5: Hono one liner withholds an amount mismatch", async () => {
  const mw = createHonoSellerEdge({
    offer: { ...OFFER },
    readChain: async () => chainOf({ amount: "9" }),
    signDelivery,
    recordE6: async () => {},
    getReceipt: () => receiptOf(),
    getPurchaseId: () => "e5-hono",
  });
  let nexted = false;
  const response = await mw(
    {
      json(body: unknown, status = 200) {
        return new Response(JSON.stringify(body), { status });
      },
    },
    async () => {
      nexted = true;
    },
  );
  assert.equal(nexted, false);
  assert.equal(response.status, 402);
  const text = await response.text();
  assert.equal(text.includes(SECRET), false);
  assert.match(text, /amount_mismatch/);
});

test("[fix] E5: Worker and Next one liners return the proof header only after a chain match", async () => {
  const cfg = {
    offer: { ...OFFER },
    readChain: async () => chainOf(),
    signDelivery,
    recordE6: async () => {},
    getReceipt: () => receiptOf(),
    getPurchaseId: () => "e5-http",
  };
  const handler = async () => new Response(SECRET, { status: 200 });
  const worker = withWorkerSellerEdge(cfg, handler);
  const next = withSellerEdge(cfg, handler);
  const workerRes = await worker(new Request("https://seller.test/paid"));
  const nextRes = await next(new Request("https://seller.test/paid"));
  assert.equal(await workerRes.text(), SECRET);
  const workerProof = workerRes.headers.get(DELIVERY_PROOF_HEADER);
  assert.equal(typeof workerProof, "string");
  assert.ok((workerProof ?? "").length > 0);
  assert.equal(await nextRes.text(), SECRET);
  assert.equal(nextRes.headers.get(DELIVERY_HASH_HEADER), deliveryBodyHash(SECRET));

  let called = false;
  const blocked = withWorkerSellerEdge(
    { ...cfg, getReceipt: () => null, getPurchaseId: () => "e5-http-fake" },
    async () => {
      called = true;
      return new Response(SECRET, { status: 200 });
    },
  );
  const denied = await blocked(new Request("https://seller.test/paid"));
  assert.equal(called, false);
  assert.equal(denied.status, 402);
  assert.equal((await denied.text()).includes(SECRET), false);
});

test("[fix] E5: Lambda@Edge one liner withholds a replay and does not become a settler", async () => {
  let calls = 0;
  const fn = withLambdaEdgeSellerEdge(
    {
      offer: { ...OFFER },
      readChain: async () => chainOf(),
      signDelivery,
      recordE6: async () => {},
      getReceipt: () => receiptOf(),
      getPurchaseId: (event: { purchaseId?: string }) => event.purchaseId ?? "e5-lambda",
    },
    async () => {
      calls += 1;
      return { status: "200", body: SECRET };
    },
  );
  const event = { Records: [{ cf: { request: { uri: "/paid" } } }], purchaseId: "e5-lambda" };
  const first = await fn(event);
  const second = await fn({ ...event, purchaseId: "e5-lambda-2" });
  assert.equal(calls, 1);
  assert.equal(first.body, SECRET);
  const proof = first.headers["x-vet402-delivery-proof"]?.[0]?.value;
  assert.equal(typeof proof, "string");
  assert.equal(verify(null, Buffer.from(deliveryBodyHash(SECRET), "utf8"), publicKey, Buffer.from(proof ?? "", "hex")), true);
  assert.equal(second.status, "409");
  assert.equal(second.body.includes(SECRET), false);
  assert.equal("settle" in fn, false);
});

function mockRes() {
  return {
    statusCode: null as number | null,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
}
