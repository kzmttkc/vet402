// POST /api/v1/payment-proof と MCP check_payment_proof。
// ネットワークへ出さない。EVM の読み手は偽物の RPC（getChainId / getTransactionReceipt）に差し替える。
// 鍵なしの回数制限は既存の publicRateLimit（メモリ、DATABASE_URL 無し）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { pad } from "viem";
import { BASE_USDC } from "@/lib/observatory/x402-payer";
import { PAYMENT_PROOF_KEYLESS_LIMIT, PAYMENT_PROOF_RPC_TIMEOUT_MS } from "@/lib/api/keyless-limits";

delete process.env.DATABASE_URL;
process.env.PROXY_HEADER_SOURCE = "generic";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;
const AMOUNT = 10_000n;

function topicAddress(addr: string): `0x${string}` {
  return pad(addr as `0x${string}`, { size: 32 });
}

function uintData(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function paymentResponse(extra: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({ success: true, transaction: TX, network: "eip155:8453", payer: PAYER, ...extra }),
    "utf8",
  ).toString("base64");
}

type Receipt = {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[];
};

function evmClient(receipt: Receipt | "missing") {
  return {
    getChainId: async () => 8453,
    getBlockNumber: async () => 500n,
    getBlock: async () => ({ timestamp: 1_700_000_000n, number: 123n }),
    getTransactionReceipt: async () => {
      if (receipt === "missing") {
        const err = new Error("missing");
        err.name = "TransactionReceiptNotFoundError";
        throw err;
      }
      return receipt;
    },
  };
}

const successReceipt: Receipt = {
  status: "success",
  blockNumber: 123n,
  logs: [
    {
      address: BASE_USDC,
      topics: [TRANSFER_TOPIC, topicAddress(PAYER), topicAddress(PAYEE)],
      data: uintData(AMOUNT),
    },
  ],
};

let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`;
}

async function post(body: unknown, ip: string, deps?: unknown) {
  const { handlePaymentProof } = await import("@/lib/payment-proof/handle");
  const req = new NextRequest("http://localhost/api/v1/payment-proof", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  });
  return handlePaymentProof(req, deps as never);
}

test("llms.txt と /docs/api に payment-proof の節がある", () => {
  const llms = readFileSync("public/llms.txt", "utf8");
  const docs = readFileSync("src/app/docs/api/page.tsx", "utf8");
  const openapi = readFileSync("docs/openapi.yaml", "utf8");
  const line = llms.split("\n").find((l) => l.includes("/api/v1/payment-proof"));
  assert.ok(line, "llms.txt に payment-proof が無い");
  assert.ok(line.includes("POST /api/v1/payment-proof"));
  assert.equal(line.includes(";"), false);
  assert.equal(/[—–]/.test(line), false);
  assert.equal(/\b(we|our|us)\b/i.test(line), false);
  assert.ok(line.includes(`${PAYMENT_PROOF_KEYLESS_LIMIT} requests a minute per IP`));
  assert.ok(line.includes(`${PAYMENT_PROOF_RPC_TIMEOUT_MS / 1000} seconds`));
  assert.ok(docs.includes('path: "/api/v1/payment-proof"'));
  assert.ok(openapi.includes("/api/v1/payment-proof:"));
});

test("base64 の PAYMENT-RESPONSE を解読し、見つかった tx の from・to・額を返す", async () => {
  const seen: { network?: string; tx?: string; payer?: string | null } = {};
  const res = await post({ paymentResponse: paymentResponse() }, freshIp(), {
    now: () => new Date("2026-11-12T00:00:00.000Z"),
    readers: {
      evm: () => {
        seen.network = "called";
        return evmClient(successReceipt);
      },
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found, true);
  assert.equal(body.network, "eip155:8453");
  assert.equal(body.tx, TX);
  assert.equal(body.block, "123");
  assert.equal(body.from, PAYER.toLowerCase());
  assert.equal(body.to, PAYEE.toLowerCase());
  assert.equal(body.asset, BASE_USDC.toLowerCase());
  assert.equal(body.amount, AMOUNT.toString());
  assert.equal(body.status, "confirmed");
  assert.equal(body.explorer, `https://basescan.org/tx/${TX}`);
  assert.equal(body.as_of, "2026-11-12T00:00:00.000Z");
  assert.equal(seen.network, "called");

  const direct = await post({ network: "base", transaction: TX }, freshIp(), {
    now: () => new Date("2026-11-12T00:00:00.000Z"),
    readers: { evm: () => evmClient(successReceipt) },
  });
  const directBody = await direct.json();
  assert.equal(direct.status, 200);
  assert.equal(directBody.network, "eip155:8453");
  assert.equal(directBody.from, PAYER.toLowerCase());
  assert.equal(directBody.amount, "10000");
});

test("見つからない tx は found false と not_found", async () => {
  const res = await post({ paymentResponse: paymentResponse() }, freshIp(), {
    now: () => new Date("2026-11-12T00:00:00.000Z"),
    readers: { evm: () => evmClient("missing") },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found, false);
  assert.equal(body.status, "not_found");
  assert.equal(body.tx, TX);
  assert.equal(body.network, "eip155:8453");
  assert.equal(body.from, null);
  assert.equal(body.to, null);
  assert.equal(body.amount, null);
  assert.equal(body.block, null);
});

test("購入で読み直していない網は unsupported_network で、RPC を呼ばない", async () => {
  let called = false;
  const res = await post({ network: "eip155:1", transaction: TX }, freshIp(), {
    now: () => new Date("2026-11-12T00:00:00.000Z"),
    readers: {
      evm: () => {
        called = true;
        return evmClient(successReceipt);
      },
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(called, false);
  assert.equal(body.found, false);
  assert.equal(body.status, "unsupported_network");
  assert.equal(body.network, "eip155:1");
  assert.equal(body.tx, TX);
  assert.equal(body.amount, null);
  assert.equal(body.explorer, null);
});

test("壊れた base64 は 400 で、RPC を呼ばない", async () => {
  let called = false;
  const res = await post({ paymentResponse: "****" }, freshIp(), {
    readers: {
      evm: () => {
        called = true;
        return evmClient(successReceipt);
      },
    },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_payment_response");
  assert.equal(called, false);
});

test("IP ごとの回数を超えると 429", async () => {
  const ip = freshIp();
  const deps = {
    now: () => new Date("2026-11-12T00:00:00.000Z"),
    readers: { evm: () => evmClient("missing") },
  };
  let last = await post({ network: "eip155:1", transaction: "0xabc" }, ip, deps);
  for (let i = 1; i < PAYMENT_PROOF_KEYLESS_LIMIT; i++) {
    last = await post({ network: "eip155:1", transaction: "0xabc" }, ip, deps);
  }
  assert.equal(last.status, 200);
  const blocked = await post({ network: "eip155:1", transaction: "0xabc" }, ip, deps);
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.error, "rate_limited");
  assert.ok(blocked.headers.get("retry-after"));
});

test("RPC が時間内に返らないと 503", async () => {
  const res = await post({ network: "eip155:8453", transaction: TX }, freshIp(), {
    timeoutMs: 30,
    readers: {
      evm: () => ({
        getChainId: () => new Promise(() => {}),
        getBlockNumber: async () => 1n,
        getBlock: async () => ({ timestamp: 1n, number: 1n }),
        getTransactionReceipt: () => new Promise(() => {}),
      }),
    },
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "temporarily_unavailable");
});

test("MCP check_payment_proof は同じ from・to・額を返す", async () => {
  const { runCheckPaymentProof } = await import("@/lib/mcp/tools");
  const out = await runCheckPaymentProof(
    { payment_response: paymentResponse() },
    {
      now: () => new Date("2026-11-12T00:00:00.000Z"),
      readers: { evm: () => evmClient(successReceipt) },
    } as never,
  );
  assert.equal(out.found, true);
  assert.equal(out.from, PAYER.toLowerCase());
  assert.equal(out.to, PAYEE.toLowerCase());
  assert.equal(out.amount, "10000");
  assert.equal(out.status, "confirmed");
});
