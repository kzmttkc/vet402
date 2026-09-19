// ============================================================
// XRPL の L1 決済照合（settled を名乗らせる唯一の関門の XRPL 側・2026-09-17）。
//
//   - 形（64 hex）・network（xrpl:0）・RPC の network_id（0 = mainnet）
//   - validated かつ tesSUCCESS。未 validated は not_final（否定ではない）
//   - Destination / Account / delivered_amount（RLUSD・固定発行者・期待額以上）
//   - 我々が署名した blob の hash（auth_nonce）と claimed tx の一致
// 測っていないものを「偽物」と言わない: RPC が答えなければ rpc_unavailable。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readXrplTxResponse, rippleTimeToDate, verifyXrplSettlement } from "@/lib/observatory/settlement-verify-xrpl";
import { RLUSD_CURRENCY_HEX, RLUSD_ISSUER, type XrplRpc } from "@/lib/observatory/xrpl402-payer";

const HASH = "52B7058AC2545B2C5288C43928E77CDDC64A33DFA6E905C7D72192895AE7C766";
const PAYER = "rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL";
const PAYEE = "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32";

function txDoc(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    TransactionType: "Payment",
    Account: PAYER,
    Destination: PAYEE,
    Amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: "0.01" },
    SourceTag: 804681468,
    InvoiceID: "A".repeat(64),
    hash: HASH,
    ledger_index: 99_000_000,
    date: 800_000_000,
    validated: true,
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: "0.01" }, ...meta },
    ...overrides,
  };
}

function fakeRpc(opts: { tx?: Record<string, unknown> | Error; networkId?: number | null; serverInfoError?: Error } = {}): XrplRpc & { calls: string[] } {
  const calls: string[] = [];
  const rpc: XrplRpc = async (method) => {
    calls.push(method);
    if (method === "server_info") {
      if (opts.serverInfoError) throw opts.serverInfoError;
      return { info: opts.networkId === null ? {} : { network_id: opts.networkId ?? 0 } };
    }
    if (method === "tx") {
      if (opts.tx instanceof Error) throw opts.tx;
      return opts.tx ?? txDoc();
    }
    throw new Error(`unexpected ${method}`);
  };
  return Object.assign(rpc, { calls });
}

const input = (over: Partial<Parameters<typeof verifyXrplSettlement>[0]> = {}) => ({
  txHash: HASH,
  network: "xrpl:0",
  expectedPayTo: PAYEE,
  expectedPayer: PAYER,
  expectedAmountUnits: "10000",
  expectedAuthNonce: HASH,
  ...over,
});

test("一致すれば ok。ledger_index と close time を返す", async () => {
  const r = await verifyXrplSettlement(input(), { rpc: fakeRpc() });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.blockNumber, 99_000_000n);
    assert.equal(r.blockTimestamp?.toISOString(), rippleTimeToDate(800_000_000)!.toISOString());
    assert.equal(r.confirmations, 1n);
  }
  // 小文字の hash でも同じ tx
  assert.equal((await verifyXrplSettlement(input({ txHash: HASH.toLowerCase() }), { rpc: fakeRpc() })).ok, true);
});

test("形・network・RPC の network_id は読む前／読んだ直後に落ちる", async () => {
  const rpc = fakeRpc();
  const malformed = await verifyXrplSettlement(input({ txHash: "0x" + "a".repeat(64) }), { rpc });
  assert.equal(!malformed.ok && malformed.reason, "malformed_tx");
  assert.deepEqual(rpc.calls, [], "形が違えば RPC を叩かない");
  const wrong = await verifyXrplSettlement(input({ network: "xrpl:1" }), { rpc });
  assert.equal(!wrong.ok && wrong.reason, "wrong_chain");
  const testnet = await verifyXrplSettlement(input(), { rpc: fakeRpc({ networkId: 1 }) });
  assert.equal(!testnet.ok && testnet.reason, "wrong_chain");
  // network_id 無し = mainnet
  assert.equal((await verifyXrplSettlement(input(), { rpc: fakeRpc({ networkId: null }) })).ok, true);
});

test("署名した blob の hash と違う claimed tx は nonce_not_used（RPC を叩かない）", async () => {
  const rpc = fakeRpc();
  const r = await verifyXrplSettlement(input({ txHash: "B".repeat(64) }), { rpc });
  assert.equal(!r.ok && r.reason, "nonce_not_used");
  assert.deepEqual(rpc.calls, []);
  // 旧行（auth_nonce 無し）は従来の判定に落ちる
  assert.equal((await verifyXrplSettlement(input({ txHash: "B".repeat(64), expectedAuthNonce: null }), { rpc: fakeRpc({ tx: txDoc({ hash: "B".repeat(64) }) }) })).ok, true);
});

test("一時的な理由: RPC が答えない / txnNotFound / 未 validated / meta 無し", async () => {
  const down = await verifyXrplSettlement(input(), { rpc: fakeRpc({ serverInfoError: new Error("ECONNRESET") }) });
  assert.equal(!down.ok && down.reason, "rpc_unavailable");
  const missing = await verifyXrplSettlement(input(), { rpc: fakeRpc({ tx: new Error("xrpl_rpc_error: txnNotFound") }) });
  assert.equal(!missing.ok && missing.reason, "tx_not_found");
  const pending = await verifyXrplSettlement(input(), { rpc: fakeRpc({ tx: txDoc({ validated: false }) }) });
  assert.equal(!pending.ok && pending.reason, "not_final");
  const noMeta = await verifyXrplSettlement(input(), { rpc: fakeRpc({ tx: txDoc({ meta: undefined }) }) });
  assert.equal(!noMeta.ok && noMeta.reason, "rpc_unavailable");
});

test("恒久の否定: 失敗 tx / 宛先違い / 払い元違い / XRP で届いた / 額が足りない / Payment でない", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [txDoc({}, { TransactionResult: "tecPATH_DRY" }), "tx_reverted"],
    [txDoc({ Destination: PAYER }), "payee_mismatch"],
    [txDoc({ Account: PAYEE }), "payer_mismatch"],
    [txDoc({}, { delivered_amount: "10000" }), "amount_mismatch"],
    [txDoc({}, { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: "0.009" } }), "amount_mismatch"],
    [txDoc({}, { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: PAYER, value: "0.01" } }), "amount_mismatch"],
    [txDoc({ TransactionType: "TrustSet" }), "no_matching_transfer"],
  ];
  for (const [doc, reason] of cases) {
    const r = await verifyXrplSettlement(input(), { rpc: fakeRpc({ tx: doc }) });
    assert.equal(!r.ok && r.reason, reason, JSON.stringify(doc).slice(0, 120));
  }
  // 多く届いた分は損ではない（期待額以上）
  assert.equal((await verifyXrplSettlement(input(), { rpc: fakeRpc({ tx: txDoc({}, { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: "0.02" } }) }) })).ok, true);
});

test("XRPL_RPC_URL 未設定なら公開 RPC へ倒れず rpc_unavailable（レビュー #2）", async () => {
  const saved = process.env.XRPL_RPC_URL;
  delete process.env.XRPL_RPC_URL;
  try {
    const r = await verifyXrplSettlement(input());
    assert.equal(!r.ok && r.reason, "rpc_unavailable");
    assert.match((!r.ok && r.detail) || "", /xrpl_rpc_unset/);
  } finally {
    if (saved === undefined) delete process.env.XRPL_RPC_URL;
    else process.env.XRPL_RPC_URL = saved;
  }
});

test("readXrplTxResponse: API v1（最上位）と v2（tx_json）の両方を読む", () => {
  const v1 = readXrplTxResponse(txDoc());
  assert.equal(v1.tx.Destination, PAYEE);
  assert.equal(v1.ledgerIndex, 99_000_000);
  const v2 = readXrplTxResponse({ tx_json: { TransactionType: "Payment", Destination: PAYEE, Account: PAYER }, meta: { TransactionResult: "tesSUCCESS" }, validated: true, ledger_index: 5, hash: HASH, close_time_iso: "2026-09-17T00:00:00Z" });
  assert.equal(v2.tx.Destination, PAYEE);
  assert.equal(v2.ledgerIndex, 5);
  assert.equal(v2.closeTime?.toISOString(), "2026-09-17T00:00:00.000Z");
  assert.equal(rippleTimeToDate(0)?.toISOString(), "2000-01-01T00:00:00.000Z");
});

// 2026-09-19（横断監査 W4 → レビュー W-1）: detail は DB に残る。XRPL_RPC_URL も鍵入りの形を取りうる。
test("rpc_unavailable の detail は RPC の URL を伏字にする", async () => {
  const r = await verifyXrplSettlement(input(), {
    rpc: fakeRpc({ serverInfoError: new Error("connect ECONNREFUSED wss://xrpl.example/v2/SECRETKEY123") }),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "rpc_unavailable");
  assert.equal(r.detail?.includes("SECRETKEY123"), false, r.detail);
  assert.ok(r.detail?.includes("<url>"), r.detail);
});
