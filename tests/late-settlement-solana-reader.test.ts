// ============================================================
// Solana の読み手（2026-11-03・recover-late.ts makeSolanaTransferReader / makeSolanaMemoReader）。
//
// 守ること:
//  1. 署名一覧は購入元の USDC の ATA に問い、新しい順に遡る。窓より古い署名に届く前に頁の上限に当たれば例外（[] と言わない）。
//  2. 窓の中の署名だけ取引を読み、宛先 owner の USDC の受領額（残高差分）を value にする。購入元の USDC が減っていない取引・
//     失敗した取引は数えない。from / to は呼び手の表記のまま。
//  3. Solana 以外の network・SOLANA_RPC_URL なし・genesis が違う・先端が窓に届いていないときは null。
//  4. memo の読み手は spl-memo の文字列を小文字で返す。読めなければ null。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSolanaMemoReader, makeSolanaTransferReader, SOLANA_LATE_READ_MAX_PAGES, SOLANA_LATE_READ_SIGNATURES_PER_PAGE, type SolanaLateReadRpc } from "@/lib/settlements/recover-late";
import { solanaUsdcTokenAccount } from "@/lib/settlements/index-solana";
import { SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PAYER = "7Vz5aYk4F3bC9dE2fG6hJ8kL1mN3pQ5rS7tU9vW2xY4z";
const PAY_TO = "4Nq8bYc2DdE3fF5gG7hH9jJ1kK3lL5mM7nN9oO2pP4qQ";
const AT = Date.parse("2026-09-22T00:00:07Z");
const FROM = new Date(AT - 2 * 60_000);
const TO = new Date(AT + 30 * 60_000);
const SIG_IN = "5KtPn1LGuxhFqnXG3cJaqbSMVsHzNjqBW7wZ2x8kE3u9eQ1x4vYdL7mRcT2sA6bH9pF3gJ5kN8qW1rV4tY7uZ3mD";
const SIG_OLD = "2AbCdEfGhJkLmNpQrStUvWxYz1234567890AbCdEfGhJkLmNpQrStUvWxYz1234567890AbCdEfGhJkLmNpQ";
const SIG_NEW = "3ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210ZyXwVuTsRq";
const MEMO = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

type Tx = NonNullable<Awaited<ReturnType<SolanaLateReadRpc["getParsedTransaction"]>>>;
const balances = (payerAmount: [string, string], payeeAmount: [string, string]) => ({
  pre: [
    { accountIndex: 1, mint: SOLANA_USDC_MINT, owner: PAYER, uiTokenAmount: { amount: payerAmount[0] } },
    { accountIndex: 2, mint: SOLANA_USDC_MINT, owner: PAY_TO, uiTokenAmount: { amount: payeeAmount[0] } },
  ],
  post: [
    { accountIndex: 1, mint: SOLANA_USDC_MINT, owner: PAYER, uiTokenAmount: { amount: payerAmount[1] } },
    { accountIndex: 2, mint: SOLANA_USDC_MINT, owner: PAY_TO, uiTokenAmount: { amount: payeeAmount[1] } },
  ],
});
const paid: Tx = { blockTime: Math.floor(AT / 1000) + 2, meta: { err: null, preTokenBalances: balances(["500000", "400000"], ["0", "100000"]).pre, postTokenBalances: balances(["500000", "400000"], ["0", "100000"]).post }, memos: ["vet402", MEMO] };

function fakeRpc(o: {
  genesis?: string;
  head?: number | null;
  pages?: { signature: string; blockTime: number | null; err?: unknown }[][];
  txs?: Record<string, Tx | null>;
}) {
  const calls: { address: string; before?: string }[] = [];
  const txReads: string[] = [];
  const pages = o.pages ?? [[{ signature: SIG_IN, blockTime: Math.floor(AT / 1000) + 2 }]];
  const rpc: SolanaLateReadRpc = {
    getGenesisHash: async () => o.genesis ?? GENESIS,
    getHeadTime: async () => (o.head === undefined ? Math.floor(TO.getTime() / 1000) + 600 : o.head),
    getSignaturesForAddress: async (address, opts) => {
      calls.push({ address, before: opts.before });
      const page = pages[calls.length - 1] ?? [];
      return page.map((p) => ({ signature: p.signature, blockTime: p.blockTime, err: p.err ?? null }));
    },
    getParsedTransaction: async (signature) => {
      txReads.push(signature);
      const tx = (o.txs ?? { [SIG_IN]: paid })[signature];
      return tx === undefined ? null : tx;
    },
  };
  return { rpc, calls, txReads };
}
const query = { network: SOLANA, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };

test("Solana reader: lists the payer's USDC token account, reads the signatures inside the window and returns the payee's USDC receipt", async () => {
  const f = fakeRpc({});
  const out = await makeSolanaTransferReader(f.rpc)(query);
  assert.deepEqual(out, [{ txHash: SIG_IN, from: PAYER, to: PAY_TO, value: "100000", blockTime: new Date((Math.floor(AT / 1000) + 2) * 1000).toISOString() }]);
  assert.equal(f.calls[0].address, solanaUsdcTokenAccount(PAYER), "the payer's USDC ATA, not the wallet");
  assert.deepEqual(f.txReads, [SIG_IN], "only the signatures inside the window are read");
});

test("Solana reader: pages back until the window is passed; signatures outside the window and failed ones are skipped", async () => {
  const secs = Math.floor(AT / 1000);
  const full = Array.from({ length: SOLANA_LATE_READ_SIGNATURES_PER_PAGE }, (_, i) => ({ signature: `${SIG_NEW}${i}`, blockTime: secs + 3600 - i }));
  const f = fakeRpc({
    pages: [full, [{ signature: SIG_NEW, blockTime: secs + 3000 }, { signature: SIG_IN, blockTime: secs + 2 }, { signature: `${SIG_IN}x`, blockTime: secs + 1, err: { InstructionError: [0, "Custom"] } }, { signature: SIG_OLD, blockTime: secs - 600 }]],
  });
  const out = await makeSolanaTransferReader(f.rpc)(query);
  assert.equal(out?.length, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].before, `${SIG_NEW}${SOLANA_LATE_READ_SIGNATURES_PER_PAGE - 1}`);
  assert.deepEqual(f.txReads, [SIG_IN]);
  // The page limit is reached before the window's start: not [] — an error (the window was not read through).
  const endless = fakeRpc({ pages: Array.from({ length: SOLANA_LATE_READ_MAX_PAGES + 1 }, () => full) });
  await assert.rejects(makeSolanaTransferReader(endless.rpc)(query), /did not reach the start of the window/);
  // An empty page means the history is exhausted: the window was read.
  assert.deepEqual(await makeSolanaTransferReader(fakeRpc({ pages: [[]] }).rpc)(query), []);
});

test("Solana reader: a transfer that did not move the payer's USDC, or did not credit the payee, is not a transfer; a failed or unreadable transaction stops the read", async () => {
  const secs = Math.floor(AT / 1000);
  const page = [{ signature: SIG_IN, blockTime: secs + 2 }];
  const payeeOnly: Tx = { ...paid, meta: { err: null, preTokenBalances: balances(["500000", "500000"], ["0", "100000"]).pre, postTokenBalances: balances(["500000", "500000"], ["0", "100000"]).post } };
  assert.deepEqual(await makeSolanaTransferReader(fakeRpc({ pages: [page], txs: { [SIG_IN]: payeeOnly } }).rpc)(query), []);
  const otherPayee: Tx = { ...paid, meta: { err: null, preTokenBalances: balances(["500000", "400000"], ["0", "0"]).pre, postTokenBalances: balances(["500000", "400000"], ["0", "0"]).post } };
  assert.deepEqual(await makeSolanaTransferReader(fakeRpc({ pages: [page], txs: { [SIG_IN]: otherPayee } }).rpc)(query), []);
  const failed: Tx = { ...paid, meta: { ...paid.meta!, err: { InstructionError: [1, "Custom"] } } };
  assert.deepEqual(await makeSolanaTransferReader(fakeRpc({ pages: [page], txs: { [SIG_IN]: failed } }).rpc)(query), []);
  await assert.rejects(makeSolanaTransferReader(fakeRpc({ pages: [page], txs: { [SIG_IN]: null } }).rpc)(query), /could not be read/);
  const noOwners: Tx = { ...paid, meta: { err: null, preTokenBalances: [{ accountIndex: 2, mint: SOLANA_USDC_MINT, uiTokenAmount: { amount: "0" } }], postTokenBalances: [{ accountIndex: 2, mint: SOLANA_USDC_MINT, uiTokenAmount: { amount: "100000" } }] } };
  await assert.rejects(makeSolanaTransferReader(fakeRpc({ pages: [page], txs: { [SIG_IN]: noOwners } }).rpc)(query), /without owners/);
});

test("Solana reader: another network, another cluster, a lagging tip, or no SOLANA_RPC_URL is null", async () => {
  for (const network of ["eip155:8453", "eip155:4217", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]) {
    const f = fakeRpc({});
    assert.equal(await makeSolanaTransferReader(f.rpc)({ ...query, network }), null, network);
    assert.equal(f.calls.length, 0, network);
  }
  assert.equal(await makeSolanaTransferReader(fakeRpc({ genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }).rpc)(query), null);
  assert.equal(await makeSolanaTransferReader(fakeRpc({ head: Math.floor(TO.getTime() / 1000) - 60 }).rpc)(query), null);
  assert.equal(await makeSolanaTransferReader(fakeRpc({ head: null }).rpc)(query), null);
  assert.equal(await makeSolanaTransferReader(null)(query), null, "no SOLANA_RPC_URL → the production factory gives null");
  const saved = process.env.SOLANA_RPC_URL;
  try {
    delete process.env.SOLANA_RPC_URL;
    assert.equal(await makeSolanaTransferReader()(query), null);
    assert.equal(await makeSolanaMemoReader()({ network: SOLANA, txHash: SIG_IN, payer: PAYER }), null);
  } finally {
    if (saved === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = saved;
  }
});

test("Solana memo reader: returns the memos lowercased; null for another network, another cluster, a failed or missing transaction, or unreadable memos", async () => {
  const f = fakeRpc({ txs: { [SIG_IN]: { ...paid, memos: [" VET402 ", MEMO.toUpperCase()] } } });
  assert.deepEqual(await makeSolanaMemoReader(f.rpc)({ network: SOLANA, txHash: SIG_IN, payer: PAYER }), ["vet402", MEMO]);
  assert.equal(await makeSolanaMemoReader(f.rpc)({ network: "eip155:8453", txHash: SIG_IN, payer: PAYER }), null);
  assert.equal(await makeSolanaMemoReader(fakeRpc({ genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }).rpc)({ network: SOLANA, txHash: SIG_IN, payer: PAYER }), null);
  assert.equal(await makeSolanaMemoReader(fakeRpc({ txs: {} }).rpc)({ network: SOLANA, txHash: SIG_IN, payer: PAYER }), null);
  assert.equal(await makeSolanaMemoReader(fakeRpc({ txs: { [SIG_IN]: { ...paid, meta: { ...paid.meta!, err: {} } } } }).rpc)({ network: SOLANA, txHash: SIG_IN, payer: PAYER }), null);
  assert.equal(await makeSolanaMemoReader(fakeRpc({ txs: { [SIG_IN]: { ...paid, memos: null } } }).rpc)({ network: SOLANA, txHash: SIG_IN, payer: PAYER }), null);
});
