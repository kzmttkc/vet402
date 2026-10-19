// ============================================================
// L1 決済のオンチェーン照合 — BNB Chain（2026-10-19・段B1）。
//
// 台帳の額は 6 桁。USD1 の Transfer は 18 桁。一致は 台帳 × 10^12 だけ。
// テストは RPC に出ない（client を注入する。未設定の確認は URL を触る前に戻る）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import {
  AUTHORIZATION_USED_TOPIC,
  readAuthorizationNonces,
  readAuthorizationState,
  verifyL1Settlement,
  type AuthorizationStateClient,
  type EvmVerifyClient,
} from "@/lib/observatory/settlement-verify";
import { BNB_LEDGER_SCALE, BNB_USD1 } from "@/lib/observatory/x402-payer";

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const TX = `0x${"b5".repeat(32)}`;
const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const NONCE = `0x${"44".repeat(32)}`;
const LEDGER = "100000";
const ASSET = 10n ** 17n; // $0.10
const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

const transferLog = (amount: bigint, token = BNB_USD1, from = PAYER) => ({
  address: token.toLowerCase(),
  topics: [TRANSFER_TOPIC, pad(from), pad(PAY_TO)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
});
const authUsedLog = (token = BNB_USD1) => ({
  address: token.toLowerCase(),
  topics: [AUTHORIZATION_USED_TOPIC, pad(PAYER), NONCE],
  data: "0x",
});

function fakeClient(chainId: number, logs: unknown[]): EvmVerifyClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => 80_000_000n,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 79_000_000n, logs }),
    getBlock: async () => ({ timestamp: 1_760_000_000n }),
  } as never;
}

const run = (logs: unknown[], chainId = 56, over: Partial<Parameters<typeof verifyL1Settlement>[0]> = {}) =>
  verifyL1Settlement(
    {
      txHash: TX,
      network: "eip155:56",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: LEDGER,
      expectedAuthNonce: NONCE,
      ...over,
    },
    { client: fakeClient(chainId, logs) },
  );

test("BNB: a USD1 Transfer of 1e17 matches ledger 100000, with AuthorizationUsed", async () => {
  const result = await run([authUsedLog(), transferLog(ASSET)]);
  assert.equal(result.ok, true, result.ok === false ? `${result.reason}: ${result.detail ?? ""}` : "");
});

test("BNB: 1e17+1, the bare ledger units, and a different token are not the settlement", async () => {
  const offByOne = await run([authUsedLog(), transferLog(ASSET + 1n)]);
  assert.equal(offByOne.ok, false);
  assert.equal(offByOne.ok === false && offByOne.reason, "no_matching_transfer");
  const bare = await run([authUsedLog(), transferLog(BigInt(LEDGER))]);
  assert.equal(bare.ok, false);
  assert.equal(bare.ok === false && bare.reason, "no_matching_transfer");
  const other = await run([authUsedLog("0x3333333333333333333333333333333333333333"), transferLog(ASSET, "0x3333333333333333333333333333333333333333")]);
  assert.equal(other.ok === false && other.reason, "no_matching_transfer");
  assert.equal(ASSET, BigInt(LEDGER) * BNB_LEDGER_SCALE);
});

test("BNB: a Transfer from another payer is not our settlement", async () => {
  const other = "0x3333333333333333333333333333333333333333";
  const result = await run([authUsedLog(), transferLog(ASSET, BNB_USD1, other)]);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_matching_transfer");
});

test("BNB: an RPC that reports another chain id is wrong_chain", async () => {
  const result = await run([authUsedLog(), transferLog(ASSET)], 8453);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "wrong_chain");
});

test("BNB without BNB_RPC_URL is chain_not_yet_verifiable and does not fall through to the Base client", async () => {
  const saved = { bnb: process.env.BNB_RPC_URL, verify: process.env.BNB_VERIFY_RPC_URL, base: process.env.BASE_RPC_URL };
  try {
    delete process.env.BNB_RPC_URL;
    delete process.env.BNB_VERIFY_RPC_URL;
    process.env.BASE_RPC_URL = "http://127.0.0.1:9";
    const result = await verifyL1Settlement({
      txHash: TX,
      network: "eip155:56",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: LEDGER,
      expectedAuthNonce: NONCE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "chain_not_yet_verifiable");
    assert.match((result.ok === false && result.detail) || "", /eip155:56: BNB_VERIFY_RPC_URL_and_BNB_RPC_URL_unset/);
    assert.equal(await readAuthorizationState({ network: "eip155:56", payer: PAYER, nonce: NONCE }), null);
    assert.equal(await readAuthorizationNonces({ network: "eip155:56", txHash: TX, payer: PAYER }), null);
    const chapel = await verifyL1Settlement({
      txHash: TX,
      network: "eip155:97",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: LEDGER,
    });
    assert.equal(chapel.ok === false && chapel.reason, "chain_not_yet_verifiable");
  } finally {
    if (saved.bnb === undefined) delete process.env.BNB_RPC_URL;
    else process.env.BNB_RPC_URL = saved.bnb;
    if (saved.verify === undefined) delete process.env.BNB_VERIFY_RPC_URL;
    else process.env.BNB_VERIFY_RPC_URL = saved.verify;
    if (saved.base === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = saved.base;
  }
});

test("BNB: readAuthorizationState asks USD1 on chain id 56", async () => {
  const asked: { address?: string }[] = [];
  const client = (chainId: number): AuthorizationStateClient =>
    ({
      getChainId: async () => chainId,
      readContract: async (q: { address: string }) => {
        asked.push({ address: q.address });
        return true;
      },
    }) as never;
  assert.equal(
    await readAuthorizationState({ network: "eip155:56", payer: PAYER, nonce: NONCE }, { client: client(56) }),
    true,
  );
  assert.equal(asked.at(-1)?.address, BNB_USD1);
  assert.equal(
    await readAuthorizationState({ network: "eip155:56", payer: PAYER, nonce: NONCE }, { client: client(8453) }),
    null,
  );
});

// 2026-10-20: 照合は古いレシートを読む。BNB_RPC_URL（PublicNode）は 1〜2 時間より前を断るので、
// BNB_VERIFY_RPC_URL があればそれを先に使い、無ければ BNB_RPC_URL、どちらも無ければ null。
test("bnbVerifyRpcUrl: BNB_VERIFY_RPC_URL first, then BNB_RPC_URL, then null (never the public RPC)", async () => {
  const { bnbVerifyRpcUrl, getBnbVerifyClient } = await import("@/lib/chain/bnb");
  const saved = { bnb: process.env.BNB_RPC_URL, verify: process.env.BNB_VERIFY_RPC_URL };
  try {
    process.env.BNB_RPC_URL = "https://rpc.example/live";
    process.env.BNB_VERIFY_RPC_URL = "https://rpc.example/archive";
    assert.equal(bnbVerifyRpcUrl(), "https://rpc.example/archive");
    process.env.BNB_VERIFY_RPC_URL = "   ";
    assert.equal(bnbVerifyRpcUrl(), "https://rpc.example/live");
    delete process.env.BNB_VERIFY_RPC_URL;
    assert.equal(bnbVerifyRpcUrl(), "https://rpc.example/live");
    delete process.env.BNB_RPC_URL;
    assert.equal(bnbVerifyRpcUrl(), null);
    assert.equal(getBnbVerifyClient(), null);
  } finally {
    if (saved.bnb === undefined) delete process.env.BNB_RPC_URL;
    else process.env.BNB_RPC_URL = saved.bnb;
    if (saved.verify === undefined) delete process.env.BNB_VERIFY_RPC_URL;
    else process.env.BNB_VERIFY_RPC_URL = saved.verify;
  }
});

test("BNB with only BNB_VERIFY_RPC_URL set reads the chain (not chain_not_yet_verifiable)", async () => {
  const saved = { bnb: process.env.BNB_RPC_URL, verify: process.env.BNB_VERIFY_RPC_URL };
  try {
    delete process.env.BNB_RPC_URL;
    process.env.BNB_VERIFY_RPC_URL = "http://127.0.0.1:9";
    const result = await verifyL1Settlement({
      txHash: TX,
      network: "eip155:56",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: LEDGER,
      expectedAuthNonce: NONCE,
    });
    assert.equal(result.ok, false);
    // 届かない RPC は「読めなかった」（rpc_unavailable）であって、未設定でも「無い」でもない。
    assert.equal(result.ok === false && result.reason, "rpc_unavailable");
    // 最新の状態を読む readAuthorizationState は BNB_RPC_URL のまま（照合用の env では読まない）。
    assert.equal(await readAuthorizationState({ network: "eip155:56", payer: PAYER, nonce: NONCE }), null);
  } finally {
    if (saved.bnb === undefined) delete process.env.BNB_RPC_URL;
    else process.env.BNB_RPC_URL = saved.bnb;
    if (saved.verify === undefined) delete process.env.BNB_VERIFY_RPC_URL;
    else process.env.BNB_VERIFY_RPC_URL = saved.verify;
  }
});
