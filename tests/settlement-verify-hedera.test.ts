// ============================================================
// Hedera の L1 決済照合（settlement-verify-hedera.ts）。mirror node は差し替え、ネットへは出ない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { HBAR_ASSET, HEDERA_MAINNET_CAIP2 } from "@/lib/observatory/hedera402-payer";
import { verifyHederaSettlement, hederaConsensusToDate, type HederaMirrorFetch } from "@/lib/observatory/settlement-verify-hedera";

const TXID = "0.0.10571514@1795739901.710706809";
const CONSENSUS = "1795739905.123456789";
function mirror(over: Record<string, unknown> = {}, blocks?: unknown): HederaMirrorFetch {
  return async (url) => {
    if (url.includes("/api/v1/blocks")) {
      return {
        status: 200,
        json: async () => blocks ?? { blocks: [{ number: 102821258, timestamp: { from: "1795739904.000000000", to: "1795739906.000000000" } }] },
      };
    }
    assert.match(url, /\/api\/v1\/transactions\/0\.0\.10571514-1795739901-710706809$/);
    return {
      status: 200,
      json: async () => ({
        transactions: [
          { nonce: 1, scheduled: false, transaction_id: "0.0.10571514-1795739901-710706809", result: "SUCCESS", name: "CRYPTOTRANSFER", transfers: [] },
          {
            nonce: 0,
            scheduled: false,
            transaction_id: "0.0.10571514-1795739901-710706809",
            result: "SUCCESS",
            name: "CRYPTOTRANSFER",
            consensus_timestamp: CONSENSUS,
            transfers: [
              { account: "0.0.10968738", amount: -5473255, is_approval: false },
              { account: "0.0.10963430", amount: 5473255, is_approval: false },
              { account: "0.0.10571514", amount: -90000, is_approval: false },
              { account: "0.0.3", amount: 90000, is_approval: false },
            ],
            ...over,
          },
        ],
      }),
    };
  };
}
const input = {
  txHash: TXID,
  network: HEDERA_MAINNET_CAIP2,
  expectedPayTo: "0.0.10963430",
  expectedPayer: "0.0.10968738",
  expectedAmountUnits: "2960",
  expectedAuthNonce: TXID,
  expectedNativeAmount: "5473255",
  expectedNativeAsset: HBAR_ASSET,
};

test("verifyHederaSettlement: SUCCESS・我々の取引 ID・tinybar の完全一致で settled", async () => {
  const r = await verifyHederaSettlement(input, { fetchImpl: mirror() });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.blockNumber, 102821258n);
    assert.equal(r.blockTimestamp?.toISOString(), hederaConsensusToDate(CONSENSUS)?.toISOString());
  }
  // 売り手が mirror node の表記で返しても同じ取引。
  const dash = await verifyHederaSettlement({ ...input, txHash: "0.0.10571514-1795739901-710706809" }, { fetchImpl: mirror() });
  assert.equal(dash.ok, true);
});

test("verifyHederaSettlement: 我々の署名していない取引 ID・失敗した取引・額・受取先の不一致", async () => {
  const other = await verifyHederaSettlement({ ...input, txHash: "0.0.10571514@1795739999.000000001" }, { fetchImpl: mirror() });
  assert.equal(!other.ok && other.reason, "nonce_not_used");
  const failed = await verifyHederaSettlement(input, { fetchImpl: mirror({ result: "INSUFFICIENT_ACCOUNT_BALANCE" }) });
  assert.equal(!failed.ok && failed.reason, "tx_reverted");
  const less = await verifyHederaSettlement({ ...input, expectedNativeAmount: "5473256" }, { fetchImpl: mirror() });
  assert.equal(!less.ok && less.reason, "amount_mismatch");
  const payee = await verifyHederaSettlement({ ...input, expectedPayTo: "0.0.42" }, { fetchImpl: mirror() });
  assert.equal(!payee.ok && payee.reason, "payee_mismatch");
  const noNative = await verifyHederaSettlement({ ...input, expectedNativeAmount: null }, { fetchImpl: mirror() });
  // 期待値の欠けは我々の記録の欠け。売り手の所見（refute）にしない。
  assert.equal(!noNative.ok && noNative.reason, "chain_not_yet_verifiable");
  const noNonce = await verifyHederaSettlement({ ...input, expectedAuthNonce: null }, { fetchImpl: mirror() });
  assert.equal(!noNonce.ok && noNonce.reason, "chain_not_yet_verifiable");
  const wrong = await verifyHederaSettlement({ ...input, network: "hedera:previewnet" }, { fetchImpl: mirror() });
  assert.equal(!wrong.ok && wrong.reason, "wrong_chain");
});

test("verifyHederaSettlement: mirror node の 404 は tx_not_found、5xx と未確定の block は一時的（rpc_unavailable）", async () => {
  const nf = await verifyHederaSettlement(input, { fetchImpl: async () => ({ status: 404, json: async () => null }) });
  assert.equal(!nf.ok && nf.reason, "tx_not_found");
  const down = await verifyHederaSettlement(input, { fetchImpl: async () => ({ status: 503, json: async () => null }) });
  assert.equal(!down.ok && down.reason, "rpc_unavailable");
  const noBlock = await verifyHederaSettlement(input, { fetchImpl: mirror({}, { blocks: [] }) });
  assert.equal(!noBlock.ok && noBlock.reason, "rpc_unavailable");
  const outside = await verifyHederaSettlement(input, {
    fetchImpl: mirror({}, { blocks: [{ number: 1, timestamp: { from: "1795739906.000000001", to: "1795739907.0" } }] }),
  });
  assert.equal(!outside.ok && outside.reason, "rpc_unavailable");
});


test("verifyHederaSettlement: 同じ取引に載ったステーキング報酬（0.0.800 から）は額に数えない", async () => {
  const withReward = mirror({
    transfers: [
      { account: "0.0.10968738", amount: -5473255, is_approval: false },
      { account: "0.0.10963430", amount: 5473255 + 1234, is_approval: false },
      { account: "0.0.800", amount: -1234, is_approval: false },
      { account: "0.0.10571514", amount: -90000, is_approval: false },
      { account: "0.0.3", amount: 90000, is_approval: false },
    ],
    staking_reward_transfers: [{ account: "0.0.10963430", amount: 1234 }],
  });
  const r = await verifyHederaSettlement(input, { fetchImpl: withReward });
  assert.equal(r.ok, true);
});
