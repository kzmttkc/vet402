// ============================================================
// 2026-09-04 金の経路監査 P1-1（Solana 照合側）と P2（受領額の読み方）。
//
// P1-1: 我々が生成した memo が、その tx の memo 命令に入っていることを要求する。
//   入っていなければ「その tx はこの購入のものではない」——恒久の否定
//   （nonce_not_used）。memo を保存していない旧行は従来判定に落とす。
//   memo が読めない（RPC が命令を返さない）は否定ではなく一時的な理由。
//
// P2: 受領額は**正味残高差分**ではなく**受領（正の差分の合計）**で数える。
//   payee が同じ tx の中で受け取った USDC を転送すると正味は目減りし、
//   正しく払われた売り手を amount_mismatch と告発していた。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifySolanaSettlement,
  type SolanaVerifyRpc,
  type SolanaTokenBalance,
} from "@/lib/observatory/settlement-verify-solana";
import { SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SIG = "3NVyZKtTvvocwuMqqTjLswmhajnJugUKwCV2hAjcp4eDuYceQ2Q3hoNcR71N92EbFq5QBKonpdt93uVaqQxfkh69";
const PAYER = "34CMQ3HB3aDWPxwAbLSbQPrBtrFhi354zAsfbb3z5v2z";
const PAYEE = "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM";
const SLOT = 443_147_828;
const MEMO = "9f1c0d2b3a4e5f60718293a4b5c6d7e8";

const bal = (accountIndex: number, owner: string, amount: string): SolanaTokenBalance => ({
  accountIndex,
  mint: SOLANA_USDC_MINT,
  owner,
  uiTokenAmount: { amount, decimals: 6 },
});

function rpcWith(opts: {
  memos?: readonly string[] | null;
  pre?: SolanaTokenBalance[];
  post?: SolanaTokenBalance[];
  tokenTransfers?: { destinationIndex: number; mint: string | null; amount: string }[] | null;
}): SolanaVerifyRpc {
  const pre = opts.pre ?? [bal(2, PAYER, "6388000"), bal(3, PAYEE, "64310825")];
  const post = opts.post ?? [bal(2, PAYER, "6188000"), bal(3, PAYEE, "64510825")];
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getSignatureStatus: async () => ({
      contextSlot: SLOT + 900_000,
      value: { err: null, confirmationStatus: "finalized", slot: SLOT },
    }),
    getTransaction: async () => ({
      slot: SLOT,
      blockTime: 1_788_178_160,
      meta: { err: null, preTokenBalances: pre, postTokenBalances: post },
      memos: opts.memos === undefined ? [MEMO] : opts.memos,
      tokenTransfers: opts.tokenTransfers === undefined ? null : opts.tokenTransfers,
    }),
  };
}

const input = {
  txHash: SIG,
  network: SOLANA_MAINNET_CAIP2,
  expectedPayTo: PAYEE,
  expectedPayer: PAYER,
  expectedAmountUnits: "200000",
};

test("我々の memo が tx に入っていれば settled", async () => {
  const r = await verifySolanaSettlement({ ...input, expectedAuthNonce: MEMO }, { rpc: rpcWith({}) });
  assert.equal(r.ok, true);
});

test("我々の memo が入っていない tx は nonce_not_used（流用）", async () => {
  const r = await verifySolanaSettlement(
    { ...input, expectedAuthNonce: MEMO },
    { rpc: rpcWith({ memos: ["someone-elses-memo"] }) },
  );
  assert.equal(r.ok === false && r.reason, "nonce_not_used");
});

test("memo 命令が 1 つも無い tx も nonce_not_used", async () => {
  const r = await verifySolanaSettlement({ ...input, expectedAuthNonce: MEMO }, { rpc: rpcWith({ memos: [] }) });
  assert.equal(r.ok === false && r.reason, "nonce_not_used");
});

test("memo を読めない RPC 応答は否定ではなく rpc_unavailable", async () => {
  const r = await verifySolanaSettlement({ ...input, expectedAuthNonce: MEMO }, { rpc: rpcWith({ memos: null }) });
  assert.equal(r.ok === false && r.reason, "rpc_unavailable");
});

test("memo を保存していない旧行は従来判定に落ちる", async () => {
  const r = await verifySolanaSettlement({ ...input, expectedAuthNonce: null }, { rpc: rpcWith({ memos: [] }) });
  assert.equal(r.ok, true);
});

test("payee が同じ tx で受け取り分を送り出しても amount_mismatch にしない（命令の受領で数える）", async () => {
  // 受領 200,000 のあと 150,000 を別口座へ送出 → 残高の正味は +50,000。
  const pre = [bal(2, PAYER, "6388000"), bal(3, PAYEE, "64310825")];
  const post = [bal(2, PAYER, "6188000"), bal(3, PAYEE, String(64_310_825n + 200_000n - 150_000n))];
  const r = await verifySolanaSettlement(
    { ...input, expectedAuthNonce: MEMO },
    {
      rpc: rpcWith({
        pre,
        post,
        tokenTransfers: [
          { destinationIndex: 3, mint: SOLANA_USDC_MINT, amount: "200000" },
          { destinationIndex: 9, mint: SOLANA_USDC_MINT, amount: "150000" },
        ],
      }),
    },
  );
  assert.equal(r.ok, true, r.ok === false ? `正味差分で判定している: ${r.reason}` : "");
});

test("payee が複数口座を持ち、片方で相殺されても受領で数える", async () => {
  // 口座 3 が +200,000、同じ owner の口座 4 が -150,000（自分の口座間の移動）。
  const pre = [bal(2, PAYER, "6388000"), bal(3, PAYEE, "64310825"), bal(4, PAYEE, "500000")];
  const post = [
    bal(2, PAYER, "6188000"),
    bal(3, PAYEE, String(64_310_825n + 200_000n)),
    bal(4, PAYEE, String(500_000n - 150_000n)),
  ];
  // 命令が読めない RPC 応答でも、口座ごとの正の差分で解ける。
  const r = await verifySolanaSettlement({ ...input, expectedAuthNonce: MEMO }, { rpc: rpcWith({ pre, post }) });
  assert.equal(r.ok, true, r.ok === false ? `相殺で潰れている: ${r.reason}` : "");
});

test("受領そのものが期待額に満たなければ従来どおり amount_mismatch", async () => {
  const pre = [bal(2, PAYER, "6388000"), bal(3, PAYEE, "64310825")];
  const post = [bal(2, PAYER, "6188000"), bal(3, PAYEE, String(64_310_825n + 199_999n))];
  const r = await verifySolanaSettlement({ ...input, expectedAuthNonce: MEMO }, { rpc: rpcWith({ pre, post }) });
  assert.equal(r.ok === false && r.reason, "amount_mismatch");
});
