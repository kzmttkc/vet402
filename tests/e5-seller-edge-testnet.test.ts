// ============================================================
// E5 の受け入れ。Base Sepolia（eip155:84532）のレシート形を、売り手が渡す RPC の
// 読み（eth_chainId と eth_getTransactionReceipt）で照合する。送金はしない。
// 偽・使い回し・額の違いは中身を渡さない。正しい支払いだけ証明を返し E6 に載せる。
// 遅れの文は /api/v1/observatory/state の sellerEdgeOverhead に載る。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { memoryE6Store } from "@/lib/observatory/e6-store";
import { recordSellerEdgeOnE6 } from "@/lib/seller-edge/record";
import {
  createExpressSellerEdge,
  type FacilitatorReceipt,
} from "../packages/middleware/src/seller.js";

const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;/;
const SECRET = "SECRET_BODY_E5_TESTNET";
const FIXTURE_PATH = "packages/middleware/fixtures/base-sepolia-usdc-transfer.json";

type Fixture = {
  network: string;
  chainId: number;
  chainIdHex: string;
  asset: string;
  txHash: string;
  payTo: string;
  from: string;
  amount: string;
  receipt: {
    status: string;
    transactionHash: string;
    logs: { address: string; topics: string[]; data: string }[];
  };
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function signDelivery(value: string): string {
  return sign(null, Buffer.from(value), privateKey).toString("hex");
}

function offer(amount = fixture.amount) {
  return {
    amount,
    payTo: fixture.payTo,
    asset: fixture.asset,
    network: fixture.network,
  };
}

function facilitator(over: Partial<FacilitatorReceipt> = {}): FacilitatorReceipt {
  return {
    valid: true,
    txHash: fixture.txHash,
    amount: fixture.amount,
    payTo: fixture.payTo,
    asset: fixture.asset,
    network: fixture.network,
    ...over,
  };
}

type RpcCall = { method: string; params: readonly unknown[] };

function rpcFrom(receipt: unknown, chainIdHex = fixture.chainIdHex) {
  const calls: RpcCall[] = [];
  const rpc = async (method: string, params: readonly unknown[]) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return chainIdHex;
    if (method === "eth_getTransactionReceipt") return receipt;
    throw new Error(`unexpected rpc method ${method}`);
  };
  return { calls, rpc };
}

function cloneReceipt(amountHex: string) {
  const receipt = structuredClone(fixture.receipt);
  receipt.logs[0]!.data = amountHex;
  return receipt;
}

async function loadChain() {
  return import("../packages/middleware/src/seller-chain.js");
}

async function loadPublic() {
  return import("../src/lib/seller-edge/public-overhead.js");
}

test("[fix] E5 testnet: the fixture is Base Sepolia USDC, not a mainnet asset", () => {
  const profile = readFileSync("packages/sdk/src/chain-profile.ts", "utf8");
  const block = profile.slice(profile.indexOf('"base-sepolia"'));
  assert.match(block, new RegExp(`network: "${fixture.network}"`));
  assert.match(block, new RegExp(`chainId: ${fixture.chainId}`));
  assert.match(block, new RegExp(`asset: "${fixture.asset}"`));
  assert.equal(fixture.chainIdHex, "0x" + fixture.chainId.toString(16));
  assert.equal(fixture.receipt.logs[0]?.address.toLowerCase(), fixture.asset.toLowerCase());
  assert.equal(fixture.receipt.transactionHash, fixture.txHash);
});

test("[fix] E5 testnet: a missing receipt, a replay, and a different amount do not deliver", async () => {
  const { createSellerChainReader } = await loadChain();
  const store = memoryE6Store();
  let handlerCalls = 0;
  const seen: string[] = [];
  const edgeMod = await import("../packages/middleware/src/seller.js");
  const readGood = createSellerChainReader({
    network: fixture.network,
    asset: fixture.asset,
    rpc: rpcFrom(fixture.receipt).rpc,
  });
  const edge = edgeMod.createSellerEdge({
    offer: offer(),
    readChain: readGood,
    signDelivery,
    recordE6: async (row) => {
      seen.push(row.purchaseId);
      await recordSellerEdgeOnE6(row.purchaseId, row.seller, store);
    },
  });
  const handler = async () => {
    handlerCalls += 1;
    return { status: 200, body: SECRET };
  };

  const missingRpc = rpcFrom(null);
  const fakeEdge = edgeMod.createSellerEdge({
    offer: offer(),
    readChain: createSellerChainReader({
      network: fixture.network,
      asset: fixture.asset,
      rpc: missingRpc.rpc,
    }),
    signDelivery,
    recordE6: async () => {
      throw new Error("fake must not record");
    },
  });
  const fake = await fakeEdge.run({ purchaseId: "e5-tn-fake", receipt: facilitator() }, handler);
  assert.equal(handlerCalls, 0);
  assert.equal(fake.delivered, false);
  assert.equal(fake.reason, "payment_fake");
  assert.equal(fake.status, 402);
  assert.equal(fake.sellerMiss, false);
  assert.equal(fake.body.includes(SECRET), false);
  assert.deepEqual(
    missingRpc.calls.map((c) => c.method),
    ["eth_chainId", "eth_getTransactionReceipt"],
  );

  const first = await edge.run({ purchaseId: "e5-tn-ok", receipt: facilitator() }, handler);
  const second = await edge.run({ purchaseId: "e5-tn-replay", receipt: facilitator() }, handler);
  assert.equal(first.delivered, true);
  assert.equal(handlerCalls, 1);
  assert.equal(second.delivered, false);
  assert.equal(second.reason, "payment_replay");
  assert.equal(second.status, 409);
  assert.equal(second.body.includes(SECRET), false);
  assert.equal(second.sellerMiss, false);
  assert.equal(handlerCalls, 1);

  const high = rpcFrom(cloneReceipt("0x" + (10001).toString(16).padStart(64, "0")));
  const amountEdge = edgeMod.createSellerEdge({
    offer: offer(),
    readChain: createSellerChainReader({
      network: fixture.network,
      asset: fixture.asset,
      rpc: high.rpc,
    }),
    signDelivery,
    recordE6: async () => {
      throw new Error("amount mismatch must not record");
    },
  });
  const mismatched = await amountEdge.run({ purchaseId: "e5-tn-amount", receipt: facilitator() }, handler);
  assert.equal(mismatched.delivered, false);
  assert.equal(mismatched.reason, "amount_mismatch");
  assert.equal(mismatched.body.includes(SECRET), false);
  assert.equal(handlerCalls, 1);
  assert.deepEqual(seen, ["e5-tn-ok"]);
});

test("[fix] E5 testnet: a matching receipt returns a proof and an E6 seller leg", async () => {
  const { createSellerChainReader } = await loadChain();
  const store = memoryE6Store();
  const edgeMod = await import("../packages/middleware/src/seller.js");
  const edge = edgeMod.createSellerEdge({
    offer: offer(),
    readChain: createSellerChainReader({
      network: fixture.network,
      asset: fixture.asset,
      rpc: rpcFrom(fixture.receipt).rpc,
    }),
    signDelivery,
    recordE6: async (row) => {
      await recordSellerEdgeOnE6(row.purchaseId, row.seller, store);
    },
  });
  const result = await edge.run({ purchaseId: "e5-tn-proof", receipt: facilitator() }, async () => ({
    status: 200,
    body: SECRET,
  }));
  assert.equal(result.delivered, true);
  assert.equal(result.body, SECRET);
  const hash = result.headers["X-Vet402-Body-Hash"];
  const proof = result.headers["X-Vet402-Delivery-Proof"];
  assert.equal(typeof hash, "string");
  assert.equal(typeof proof, "string");
  assert.equal(verify(null, Buffer.from(hash ?? "", "utf8"), publicKey, Buffer.from(proof ?? "", "hex")), true);
  const row = await store.get("e5-tn-proof");
  assert.ok(row);
  assert.equal(row.seller.paymentVerified, fixture.txHash);
  assert.equal(row.seller.deliveredBodyHash, hash);
  assert.equal(row.seller.deliverySignature, proof);
  assert.equal(row.seller.vet402Middleware, true);
  assert.equal(row.payer.paymentTx, null);
});

test("[fix] E5 testnet: a mainnet chain id does not satisfy a Base Sepolia offer", async () => {
  const { createSellerChainReader } = await loadChain();
  const edgeMod = await import("../packages/middleware/src/seller.js");
  let calls = 0;
  const edge = edgeMod.createSellerEdge({
    offer: offer(),
    readChain: createSellerChainReader({
      network: fixture.network,
      asset: fixture.asset,
      rpc: rpcFrom(fixture.receipt, "0x2105").rpc,
    }),
    signDelivery,
    recordE6: async () => {
      throw new Error("wrong chain must not record");
    },
  });
  const result = await edge.run({ purchaseId: "e5-tn-wrong-chain", receipt: facilitator() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(result.delivered, false);
  assert.equal(result.reason, "network_mismatch");
  assert.equal(result.body.includes(SECRET), false);
});

test("[fix] E5 testnet: two transfers of the offer asset do not deliver", async () => {
  const { createSellerChainReader } = await loadChain();
  const receipt = structuredClone(fixture.receipt);
  receipt.logs.push(structuredClone(receipt.logs[0]!));
  const edgeMod = await import("../packages/middleware/src/seller.js");
  let calls = 0;
  const edge = edgeMod.createSellerEdge({
    offer: offer(),
    readChain: createSellerChainReader({
      network: fixture.network,
      asset: fixture.asset,
      rpc: rpcFrom(receipt).rpc,
    }),
    signDelivery,
    recordE6: async () => {
      throw new Error("ambiguous transfer must not record");
    },
  });
  const result = await edge.run({ purchaseId: "e5-tn-split", receipt: facilitator() }, async () => {
    calls += 1;
    return { status: 200, body: SECRET };
  });
  assert.equal(calls, 0);
  assert.equal(result.delivered, false);
  assert.equal(result.body.includes(SECRET), false);
});

test("[fix] E5 testnet: Express uses the chain reader and still does not settle", async () => {
  const { createSellerChainReader } = await loadChain();
  const src = readFileSync("packages/middleware/src/seller-chain.ts", "utf8");
  assert.doesNotMatch(src, /eth_send|eth_sendTransaction|signTypedData|\/settle/);
  const store = memoryE6Store();
  const mw = createExpressSellerEdge<{ purchaseId: string; receipt: FacilitatorReceipt | null }>({
    offer: offer(),
    readChain: createSellerChainReader({
      network: fixture.network,
      asset: fixture.asset,
      rpc: rpcFrom(fixture.receipt).rpc,
    }),
    signDelivery,
    recordE6: async (row) => {
      await recordSellerEdgeOnE6(row.purchaseId, row.seller, store);
    },
    getReceipt: (req) => req.receipt,
    getPurchaseId: (req) => req.purchaseId,
  });
  const denied = mockRes();
  let nexted = false;
  await mw({ purchaseId: "e5-tn-ex-fake", receipt: null }, denied, () => {
    nexted = true;
  });
  assert.equal(nexted, false);
  assert.equal(denied.statusCode, 402);
  assert.equal(JSON.stringify(denied.body).includes(SECRET), false);

  const ok = mockRes();
  await mw({ purchaseId: "e5-tn-ex-ok", receipt: facilitator() }, ok, () => {
    ok.status(200).json({ secret: SECRET });
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.body as { secret: string }).secret, SECRET);
  const saved = await store.get("e5-tn-ex-ok");
  assert.equal(saved?.seller.vet402Middleware, true);
  assert.equal(typeof ok.headers["X-Vet402-Delivery-Proof"], "string");
});

test("[fix] E5: state API publishes seller edge overhead and does not claim an unmeasured target", async () => {
  const pub = await loadPublic();
  const edgeMod = await import("../packages/middleware/src/seller.js");
  const { createSellerChainReader } = await loadChain();
  pub.resetSellerEdgeOverhead();
  try {
    const { GET } = await import("@/app/api/v1/observatory/state/route");
    const emptyRes = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
    assert.equal(emptyRes.status, 200);
    const empty = await emptyRes.json();
    assert.equal(empty.sellerEdgeOverhead.samples, 0);
    assert.equal(empty.sellerEdgeOverhead.measuredP95Ms, null);
    assert.equal(empty.sellerEdgeOverhead.targetMet, false);
    assert.match(empty.sellerEdgeOverhead.statement, /does not claim the 20 ms target/);
    assert.doesNotMatch(empty.sellerEdgeOverhead.statement, FORBIDDEN_PUBLIC_ENGLISH);
    assert.doesNotMatch(empty.sellerEdgeOverhead.about, FORBIDDEN_PUBLIC_ENGLISH);
    assert.match(empty.sellerEdgeOverhead.about, /^vet402\b/);

    const samples = Array.from({ length: 20 }, () => 27.5);
    pub.publishSellerEdgeOverhead(samples);
    const highRes = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
    const high = await highRes.json();
    assert.equal(high.sellerEdgeOverhead.samples, 20);
    assert.equal(high.sellerEdgeOverhead.measuredP95Ms, 27.5);
    assert.equal(high.sellerEdgeOverhead.targetMet, false);
    assert.match(high.sellerEdgeOverhead.statement, /p95 27\.5 ms/);
    assert.match(high.sellerEdgeOverhead.statement, /above the target/);
    assert.doesNotMatch(high.sellerEdgeOverhead.statement, /at or under the target/);
    assert.equal(JSON.stringify(high).includes('"score"'), false);

    pub.resetSellerEdgeOverhead();
    const edge = edgeMod.createSellerEdge({
      offer: offer(),
      readChain: createSellerChainReader({
        network: fixture.network,
        asset: fixture.asset,
        rpc: rpcFrom(null).rpc,
      }),
      signDelivery,
      recordE6: async () => {},
    });
    for (let i = 0; i < 20; i += 1) {
      const result = await edge.run({ purchaseId: `e5-tn-lat-${i}`, receipt: null }, async () => ({
        status: 200,
        body: SECRET,
      }));
      assert.equal(result.delivered, false);
      assert.equal(result.body.includes(SECRET), false);
    }
    const measured = edge.latency();
    assert.equal(measured.samples, 20);
    assert.equal(typeof measured.measuredP95Ms, "number");
    const published = pub.publishSellerEdgeOverhead(measured.overheadMs);
    assert.equal(published.measuredP95Ms, measured.measuredP95Ms);
    assert.equal(published.statement, measured.statement);
    assert.equal(published.targetMet, (published.measuredP95Ms ?? 99) <= published.targetP95Ms);
    if ((published.measuredP95Ms ?? 0) > 20) {
      assert.match(published.statement, /above the target/);
      assert.equal(published.targetMet, false);
    }
    assert.doesNotMatch(published.statement, FORBIDDEN_PUBLIC_ENGLISH);
    const live = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
    const body = await live.json();
    assert.equal(body.sellerEdgeOverhead.statement, measured.statement);
    assert.equal(body.sellerEdgeOverhead.measuredP95Ms, measured.measuredP95Ms);
  } finally {
    pub.resetSellerEdgeOverhead();
  }
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
