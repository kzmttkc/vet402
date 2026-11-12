// Seller edge against a Base Sepolia receipt fixture. vet402 does not send a transaction.
// Run from the repo root: npx tsx examples/seller-edge-base-sepolia/run.ts
import { readFileSync } from "node:fs";
import { createSellerChainReader } from "../../packages/middleware/src/seller-chain.js";
import { createSellerEdge } from "../../packages/middleware/src/seller-edge.js";

type Fixture = {
  network: string;
  asset: string;
  txHash: string;
  payTo: string;
  amount: string;
  chainIdHex: string;
  receipt: { logs: { data: string }[] };
};

const fixture = JSON.parse(readFileSync("packages/middleware/fixtures/base-sepolia-usdc-transfer.json", "utf8")) as Fixture;

function rpc(receipt: unknown) {
  return async (method: string) => {
    if (method === "eth_chainId") return fixture.chainIdHex;
    if (method === "eth_getTransactionReceipt") return receipt;
    throw new Error("vet402 refuses a chain method other than a read");
  };
}

const offer = {
  amount: fixture.amount,
  payTo: fixture.payTo,
  asset: fixture.asset,
  network: fixture.network,
};

function edgeFor(receipt: unknown) {
  return createSellerEdge({
    offer,
    readChain: createSellerChainReader({ network: fixture.network, asset: fixture.asset, rpc: rpc(receipt) }),
    signDelivery: (hash) => `fixture:${hash}`,
    recordE6: async () => {},
  });
}

async function main(): Promise<void> {
  const handler = async () => ({ status: 200, body: "paid-body" });
  const receipt = {
    valid: true,
    txHash: fixture.txHash,
    amount: fixture.amount,
    payTo: fixture.payTo,
    asset: fixture.asset,
    network: fixture.network,
  };

  const fake = await edgeFor(null).run({ purchaseId: "ex-fake", receipt }, handler);
  const matchedEdge = edgeFor(fixture.receipt);
  const matched = await matchedEdge.run({ purchaseId: "ex-ok", receipt }, handler);
  const replay = await matchedEdge.run({ purchaseId: "ex-replay", receipt }, handler);
  const high = structuredClone(fixture.receipt);
  high.logs[0]!.data = "0x" + (10001).toString(16).padStart(64, "0");
  const amount = await edgeFor(high).run({ purchaseId: "ex-amount", receipt }, handler);

  if (fake.reason !== "payment_fake" || fake.body.includes("paid-body")) throw new Error("fake delivered");
  if (!matched.delivered || matched.body !== "paid-body") throw new Error("match withheld");
  if (replay.reason !== "payment_replay" || replay.body.includes("paid-body")) throw new Error("replay delivered");
  if (amount.reason !== "amount_mismatch" || amount.body.includes("paid-body")) throw new Error("amount delivered");

  console.log(
    "vet402 read the Base Sepolia fixture. A fake payment, a replay, and an amount mismatch did not return the body. A matching payment returned the body.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "seller edge example failed");
  process.exit(1);
});
