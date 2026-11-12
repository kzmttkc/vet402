// Dist entry for the seller edge. The trust gate tests stay in the other files.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { test } from "node:test";
import {
  createSellerChainReader,
  createSellerEdge,
  deliveryBodyHash,
  DELIVERY_HASH_HEADER,
  DELIVERY_PROOF_HEADER,
} from "../dist/seller.js";

const SECRET = "SECRET_BODY_E5";
const OFFER = {
  amount: "10000",
  payTo: "0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  network: "eip155:84532",
};
const TX = "0x" + "ab".repeat(32);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function signDelivery(value) {
  return sign(null, Buffer.from(value), privateKey).toString("hex");
}

function receipt(over = {}) {
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

function edgeWith(chain) {
  return createSellerEdge({
    offer: { ...OFFER },
    readChain: async () => chain,
    signDelivery,
    recordE6: async () => {},
    clock: () => 0,
  });
}

test("dist seller edge: fake, replay, and amount mismatch withhold the body", async () => {
  const fake = edgeWith({
    txHash: TX,
    amount: OFFER.amount,
    payTo: OFFER.payTo,
    asset: OFFER.asset,
    network: OFFER.network,
  });
  let calls = 0;
  const missing = await fake.run({ purchaseId: "dist-fake", receipt: null }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(missing.reason, "payment_fake");
  assert.equal(missing.body.includes(SECRET), false);

  const amount = edgeWith({
    txHash: TX,
    amount: "10001",
    payTo: OFFER.payTo,
    asset: OFFER.asset,
    network: OFFER.network,
  });
  const mismatched = await amount.run({ purchaseId: "dist-amount", receipt: receipt() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(mismatched.reason, "amount_mismatch");
  assert.equal(mismatched.body.includes(SECRET), false);

  const chain = {
    txHash: TX,
    amount: OFFER.amount,
    payTo: OFFER.payTo,
    asset: OFFER.asset,
    network: OFFER.network,
  };
  const recorded = [];
  const ok = createSellerEdge({
    offer: { ...OFFER },
    readChain: async () => chain,
    signDelivery,
    recordE6: async (row) => {
      recorded.push(row);
    },
    clock: () => 0,
  });
  const first = await ok.run({ purchaseId: "dist-ok", receipt: receipt() }, async () => ({ status: 200, body: SECRET }));
  const second = await ok.run({ purchaseId: "dist-replay", receipt: receipt() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(first.delivered, true);
  assert.equal(first.body, SECRET);
  const hash = first.headers[DELIVERY_HASH_HEADER];
  const proof = first.headers[DELIVERY_PROOF_HEADER];
  assert.equal(hash, deliveryBodyHash(SECRET));
  assert.equal(hash, createHash("sha256").update(SECRET, "utf8").digest("hex"));
  assert.equal(verify(null, Buffer.from(hash), publicKey, Buffer.from(proof, "hex")), true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].seller.vet402Middleware, true);
  assert.equal(recorded[0].seller.paymentVerified, TX);
  assert.equal(second.reason, "payment_replay");
  assert.equal(second.body.includes(SECRET), false);
  assert.equal(calls, 0);
  assert.equal(ok.latency().targetMet, false);
});

test("dist seller chain reader withholds a receipt the chain does not have", async () => {
  const readChain = createSellerChainReader({
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpc: async (method) => {
      if (method === "eth_chainId") return "0x14a34";
      if (method === "eth_getTransactionReceipt") return null;
      throw new Error(method);
    },
  });
  const edge = createSellerEdge({
    offer: { ...OFFER },
    readChain,
    signDelivery,
    recordE6: async () => {
      throw new Error("missing receipt must not record");
    },
  });
  let calls = 0;
  const result = await edge.run({ purchaseId: "dist-chain-missing", receipt: receipt() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, "payment_fake");
  assert.equal(result.body.includes(SECRET), false);
});
