// ============================================================
// XRPL-402 payer（2026-09-17）——「作る側」の正しさを DB もネットワークも無しで固定する。
//
//  - accept の選別: 実物の 402（gridpulse.theaslangroupllc.com・2026-09-17 取得）で RLUSD を選び、
//    同じ壁の XRP accept は v1 では払わない（no_eligible_accept / asset_not_usd）。
//    発行者が固定値と違う RLUSD・invoiceId 無し・sourceTag 不正は予約より前に落ちる。
//  - InvoiceID は正本 invoiceIdToInvoiceIdField と同じ SHA-256（大文字 hex）。
//  - tx は入力（sequence・validated ledger）が同じなら blob も hash も同じ（決定的）。
//  - 封筒は EVM / Solana と同じ v2 PAYMENT-SIGNATURE、payload は { signedTxBlob, invoiceId }（2026-09-19:
//    t54 の facilitator は payload.invoiceId が無いと invalid_payload で断る。本番 2026-09-18T00:01:27Z の 402）。
//  - "0.01" → 10000 units（USDC と同じ 6 桁の目盛り）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Wallet, decode, hashes } from "xrpl";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_ISSUER,
  XRPL_FEE_CAP_DROPS,
  XRPL_MAINNET_CAIP2,
  buildXrplPayment,
  clampFeeDrops,
  invoiceIdField,
  lastLedgerOffset,
  rlusdToUnits,
  rlusdToUnitsFloor,
  selectXrplAccept,
  signXrplPayment,
  unitsToRlusdValue,
  xrplPaymentPayload,
} from "@/lib/observatory/xrpl402-payer";
import { encodePaymentHeader } from "@/lib/observatory/x402-payer";

/** 実物の 402 の accept（2026-09-17・HTTP 402 の payment-required ヘッダから）。 */
const RLUSD_ACCEPT = {
  scheme: "exact",
  network: "xrpl:0",
  asset: "524C555344000000000000000000000000000000",
  extra: { issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", invoiceId: "9ACC8E92BFAA468E8E02F67F82FFBEDB", sourceTag: 804681468 },
  payTo: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32",
  amount: "0.01",
  maxTimeoutSeconds: 300,
};
const XRP_ACCEPT = { ...RLUSD_ACCEPT, asset: "XRP", amount: "10000", extra: { invoiceId: "9ACC8E92BFAA468E8E02F67F82FFBEDB", sourceTag: 804681468 } };

// 決定的なテスト鍵（本物の資金とは無関係）。
const WALLET = Wallet.fromSeed("sEdTM1uX8pu2do5XvTnutH6HsouMaM2");

test("rlusdToUnits: \"0.01\" → 10000、6 桁を超える細かさ・0・不正は null", () => {
  assert.equal(rlusdToUnits("0.01"), 10_000n);
  assert.equal(rlusdToUnits("1"), 1_000_000n);
  assert.equal(rlusdToUnits("0.010"), 10_000n);
  assert.equal(rlusdToUnits("0.000001"), 1n);
  assert.equal(rlusdToUnits("0.0000001"), null, "台帳に載らない桁");
  assert.equal(rlusdToUnits("0"), null);
  assert.equal(rlusdToUnits("-1"), null);
  assert.equal(rlusdToUnits("1e-2"), null);
  assert.equal(rlusdToUnits("abc"), null);
  assert.equal(rlusdToUnitsFloor("1.2345678"), 1_234_567n);
  assert.equal(unitsToRlusdValue(10_000n), "0.01");
  assert.equal(unitsToRlusdValue(1_000_000n), "1");
  assert.equal(unitsToRlusdValue(1_234_567n), "1.234567");
});

test("invoiceIdField: 正本と同じ SHA-256（UTF-8）の大文字 hex", () => {
  assert.equal(invoiceIdField("abc"), "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD");
  assert.equal(
    invoiceIdField("9ACC8E92BFAA468E8E02F67F82FFBEDB"),
    createHash("sha256").update("9ACC8E92BFAA468E8E02F67F82FFBEDB", "utf8").digest("hex").toUpperCase(),
  );
  assert.match(invoiceIdField("x"), /^[0-9A-F]{64}$/);
});

test("selectXrplAccept: 実物の壁（RLUSD + XRP）から RLUSD を選ぶ。units は 10000", () => {
  const sel = selectXrplAccept([XRP_ACCEPT, RLUSD_ACCEPT], { declaredAmount: "0.01", declaredPayTo: RLUSD_ACCEPT.payTo });
  assert.equal(sel.reason, null);
  assert.equal(sel.accept?.asset, RLUSD_CURRENCY_HEX);
  assert.equal(sel.accept && "amountUnits" in sel ? sel.amountUnits : null, 10_000n);
  // カタログの宣言が別表記でも同じ額なら通る
  assert.equal(selectXrplAccept([RLUSD_ACCEPT], { declaredAmount: "0.010", declaredPayTo: null }).reason, null);
});

test("selectXrplAccept: network は完全一致。`xrpl` / `XRPL` / `xrpl:mainnet` と名乗る壁は選ばない（レビュー #1）", () => {
  for (const network of ["xrpl", "XRPL", "xrpl:mainnet", "Xrpl:0", "xrpl:1"]) {
    const sel = selectXrplAccept([{ ...RLUSD_ACCEPT, network }], { declaredAmount: "0.01", declaredPayTo: RLUSD_ACCEPT.payTo });
    assert.equal(sel.reason, "no_eligible_accept", network);
    assert.equal(sel.detail, null, network);
  }
  assert.equal(selectXrplAccept([{ ...RLUSD_ACCEPT, network: XRPL_MAINNET_CAIP2 }], { declaredAmount: null, declaredPayTo: null }).accept?.network, "xrpl:0");
});

test("clampFeeDrops: fee の open_ledger_fee を [12, 1000] に収める。読めない・0 は 12、上限超は null（署名しない）", () => {
  assert.equal(XRPL_FEE_CAP_DROPS, 1_000n);
  assert.equal(clampFeeDrops("10"), "12", "基本手数料より下は既定へ");
  assert.equal(clampFeeDrops("12"), "12");
  assert.equal(clampFeeDrops("250"), "250");
  assert.equal(clampFeeDrops("1000"), "1000");
  assert.equal(clampFeeDrops("1001"), null, "上限超は 12 に倒さず、そのバッチの XRPL を署名しない（出荷前レビュー #1）");
  assert.equal(clampFeeDrops("999999999"), null);
  assert.equal(clampFeeDrops("0"), "12");
  assert.equal(clampFeeDrops(undefined), "12");
  assert.equal(clampFeeDrops("abc"), "12");
  assert.equal(clampFeeDrops(12), "12");
});

test("selectXrplAccept: XRP だけの壁は v1 では払わない（no_eligible_accept / asset_not_usd）", () => {
  const sel = selectXrplAccept([XRP_ACCEPT], { declaredAmount: "10000", declaredPayTo: RLUSD_ACCEPT.payTo });
  assert.equal(sel.reason, "no_eligible_accept");
  assert.equal(sel.detail, "asset_not_usd");
  // USDC IOU（発行者未確認）も v1 では払わない
  const usdc = selectXrplAccept([{ ...RLUSD_ACCEPT, asset: "5553444300000000000000000000000000000000" }], { declaredAmount: null, declaredPayTo: null });
  assert.equal(usdc.reason, "no_eligible_accept");
  assert.equal(usdc.detail, "asset_unsupported");
  // 別チェーンだけなら detail 無し
  const evm = selectXrplAccept([{ ...RLUSD_ACCEPT, network: "eip155:8453" }], { declaredAmount: null, declaredPayTo: null });
  assert.equal(evm.reason, "no_eligible_accept");
  assert.equal(evm.detail, null);
});

test("selectXrplAccept: 発行者が固定値と違う RLUSD は署名しない（issuer_mismatch）", () => {
  const sel = selectXrplAccept(
    [{ ...RLUSD_ACCEPT, extra: { ...RLUSD_ACCEPT.extra, issuer: "rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL" } }],
    { declaredAmount: "0.01", declaredPayTo: RLUSD_ACCEPT.payTo },
  );
  assert.equal(sel.reason, "no_eligible_accept");
  assert.equal(sel.detail, "issuer_mismatch");
  // 発行者欠落も同じ
  const none = selectXrplAccept([{ ...RLUSD_ACCEPT, extra: { invoiceId: "a", sourceTag: 1 } }], { declaredAmount: null, declaredPayTo: null });
  assert.equal(none.detail, "issuer_mismatch");
});

test("selectXrplAccept: 組めない形（invoiceId 無し・sourceTag 不正・payTo 不正・7 桁の額）は予約より前に落ちる", () => {
  const cases: Record<string, unknown>[] = [
    { extra: { issuer: RLUSD_ISSUER, sourceTag: 804681468 } },
    { extra: { issuer: RLUSD_ISSUER, invoiceId: "", sourceTag: 804681468 } },
    { extra: { issuer: RLUSD_ISSUER, invoiceId: "x", sourceTag: "804681468" } },
    { extra: { issuer: RLUSD_ISSUER, invoiceId: "x", sourceTag: 2 ** 32 } },
    { extra: { issuer: RLUSD_ISSUER, invoiceId: "x", sourceTag: 1, destinationTag: -1 } },
    { payTo: "0x0000000000000000000000000000000000000001" },
    { payTo: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh33" },
    { amount: "0.0000001" },
    { maxTimeoutSeconds: 120.5 },
  ];
  for (const c of cases) {
    const sel = selectXrplAccept([{ ...RLUSD_ACCEPT, ...c }], { declaredAmount: null, declaredPayTo: null });
    assert.equal(sel.reason, "no_eligible_accept", JSON.stringify(c));
    assert.equal(sel.detail, "unbuildable", JSON.stringify(c));
  }
});

test("selectXrplAccept: payTo → 価格 → 上限の順で断る（EVM / Solana と同じ語彙）", () => {
  assert.equal(
    selectXrplAccept([RLUSD_ACCEPT], { declaredAmount: "0.01", declaredPayTo: "rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL" }).reason,
    "payto_mismatch",
  );
  assert.equal(selectXrplAccept([RLUSD_ACCEPT], { declaredAmount: "0.02", declaredPayTo: null }).reason, "price_mismatch");
  assert.equal(selectXrplAccept([{ ...RLUSD_ACCEPT, amount: "1.5" }], { declaredAmount: null, declaredPayTo: null }).reason, "over_cap");
  // 宣言が読めない額なら不一致側へ倒す
  assert.equal(selectXrplAccept([RLUSD_ACCEPT], { declaredAmount: "ten", declaredPayTo: null }).reason, "price_mismatch");
});

test("buildXrplPayment: 正本の Payment の形・決定的・LastLedgerSequence は 120 秒で頭打ち", () => {
  const tx = buildXrplPayment({ account: WALLET.classicAddress, accept: RLUSD_ACCEPT, sequence: 42, validatedLedgerIndex: 100_000 });
  assert.equal(tx.TransactionType, "Payment");
  assert.equal(tx.Account, WALLET.classicAddress);
  assert.equal(tx.Destination, RLUSD_ACCEPT.payTo);
  assert.deepEqual(tx.Amount, { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: "0.01" });
  assert.deepEqual(tx.SendMax, tx.Amount);
  assert.notEqual(tx.SendMax, tx.Amount, "Amount と SendMax は別オブジェクト（レビュー #7c）");
  assert.equal(tx.Fee, "12");
  assert.equal(buildXrplPayment({ account: WALLET.classicAddress, accept: RLUSD_ACCEPT, sequence: 1, validatedLedgerIndex: 1, feeDrops: "250" }).Fee, "250");
  assert.throws(() => buildXrplPayment({ account: WALLET.classicAddress, accept: RLUSD_ACCEPT, sequence: 1, validatedLedgerIndex: 1, feeDrops: "1001" }), /fee/);
  assert.throws(() => buildXrplPayment({ account: WALLET.classicAddress, accept: RLUSD_ACCEPT, sequence: 1, validatedLedgerIndex: 1, feeDrops: "0" }), /fee/);
  assert.equal(tx.Sequence, 42);
  assert.equal(tx.SourceTag, 804681468);
  assert.equal(tx.InvoiceID, invoiceIdField("9ACC8E92BFAA468E8E02F67F82FFBEDB"));
  assert.equal("DestinationTag" in tx, false);
  assert.equal("NetworkID" in tx, false, "xrpl:0 には NetworkID を付けない");
  // maxTimeoutSeconds 300 でも窓は 120 秒 → ceil(120/4)+2 = 32 ledger
  assert.equal(lastLedgerOffset(300), 32);
  assert.equal(tx.LastLedgerSequence, 100_032);
  assert.equal(lastLedgerOffset(undefined), 32);
  assert.equal(lastLedgerOffset(10), Math.ceil(60 / 4) + 2);
  // destinationTag は uint32 のときだけ載る
  const withDt = buildXrplPayment({ account: WALLET.classicAddress, accept: { ...RLUSD_ACCEPT, extra: { ...RLUSD_ACCEPT.extra, destinationTag: 7 } }, sequence: 1, validatedLedgerIndex: 1 });
  assert.equal(withDt.DestinationTag, 7);
  // 通貨コードは literal "RLUSD" でも hex に正規化する（XRPL の 5 文字コードは hex でしか表せない）
  const literal = buildXrplPayment({ account: WALLET.classicAddress, accept: { ...RLUSD_ACCEPT, asset: "RLUSD" }, sequence: 1, validatedLedgerIndex: 1 });
  assert.equal(literal.Amount.currency, RLUSD_CURRENCY_HEX);
  assert.throws(() => buildXrplPayment({ account: WALLET.classicAddress, accept: XRP_ACCEPT, sequence: 1, validatedLedgerIndex: 1 }), /not RLUSD/);
});

test("signXrplPayment: blob を decode すると同じ tx、hash は blob から再計算できる、同じ入力なら同じ blob", () => {
  const tx = buildXrplPayment({ account: WALLET.classicAddress, accept: RLUSD_ACCEPT, sequence: 42, validatedLedgerIndex: 100_000 });
  const a = signXrplPayment(WALLET, tx);
  const b = signXrplPayment(WALLET, tx);
  assert.equal(a.signedTxBlob, b.signedTxBlob, "決定的");
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9A-F]{64}$/);
  assert.equal(hashes.hashSignedTx(a.signedTxBlob), a.hash);
  const decoded = decode(a.signedTxBlob) as Record<string, unknown>;
  assert.equal(decoded.TransactionType, "Payment");
  assert.equal(decoded.Destination, RLUSD_ACCEPT.payTo);
  assert.equal(decoded.Account, WALLET.classicAddress);
  assert.deepEqual(decoded.Amount, tx.Amount);
  assert.equal(decoded.InvoiceID, tx.InvoiceID);
  assert.equal(decoded.SourceTag, 804681468);
  assert.equal(decoded.LastLedgerSequence, 100_032);
  assert.equal(typeof decoded.TxnSignature, "string");
  assert.equal(decoded.SigningPubKey, WALLET.publicKey);
});

/**
 * 本番で断られた壁の実物（2026-09-19 取得・https://macropulse.theaslangroupllc.com/api/session-brief の
 * payment-required ヘッダの 14 accept のうち XRPL の 2 つ。invoiceId は 402 ごとに新しい）。
 */
const MACROPULSE_XRP_ACCEPT = {
  scheme: "exact",
  network: "xrpl:0",
  asset: "XRP",
  amount: "100000",
  payTo: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32",
  maxTimeoutSeconds: 300,
  extra: { sourceTag: 804681468, invoiceId: "459218C4E8C04467ABBF1232597338F2" },
};
const MACROPULSE_RLUSD_ACCEPT = {
  scheme: "exact",
  network: "xrpl:0",
  asset: "524C555344000000000000000000000000000000",
  amount: "0.1",
  payTo: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32",
  maxTimeoutSeconds: 300,
  extra: { sourceTag: 804681468, issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", invoiceId: "97F7BA1328FE4BD8996E10ADC16D1B47" },
};
const MACROPULSE_URL = "https://macropulse.theaslangroupllc.com/api/session-brief";

test("封筒: v2 PAYMENT-SIGNATURE、accepted は壁の accept そのもの、payload は { signedTxBlob, invoiceId }", () => {
  const tx = buildXrplPayment({ account: WALLET.classicAddress, accept: RLUSD_ACCEPT, sequence: 1, validatedLedgerIndex: 1 });
  const { signedTxBlob } = signXrplPayment(WALLET, tx);
  const h = encodePaymentHeader({ x402Version: 2, accept: RLUSD_ACCEPT, payload: xrplPaymentPayload(RLUSD_ACCEPT, signedTxBlob), resourceUrl: "https://gridpulse.theaslangroupllc.com/api/energy/carbon-intensity" });
  assert.equal(h.headerName, "PAYMENT-SIGNATURE");
  const body = JSON.parse(Buffer.from(h.headerValue, "base64").toString("utf8"));
  assert.equal(body.x402Version, 2);
  assert.equal(body.accepted.network, XRPL_MAINNET_CAIP2);
  assert.equal(body.accepted.asset, RLUSD_CURRENCY_HEX);
  assert.equal(body.accepted.amount, "0.01");
  assert.deepEqual(body.accepted.extra, RLUSD_ACCEPT.extra);
  assert.equal(body.payload.signedTxBlob, signedTxBlob);
  assert.equal(body.payload.invoiceId, RLUSD_ACCEPT.extra.invoiceId);
  assert.equal(decode(body.payload.signedTxBlob).TransactionType, "Payment");
});

test("t54 の facilitator の形（2026-09-19）: 本番で invalid_payload だった壁の accept から、/verify が isValid:true を返した形を作る", () => {
  // 壁は XRP と RLUSD を並べる。払うのは RLUSD の方（"0.1" = 100000 units）。
  const selection = selectXrplAccept([MACROPULSE_XRP_ACCEPT, MACROPULSE_RLUSD_ACCEPT], { declaredAmount: "0.1", declaredPayTo: MACROPULSE_RLUSD_ACCEPT.payTo });
  assert.equal(selection.reason, null);
  assert.equal(selection.accept, MACROPULSE_RLUSD_ACCEPT);
  assert.equal(selection.accept && selection.amountUnits, 100_000n);

  const tx = buildXrplPayment({ account: WALLET.classicAddress, accept: MACROPULSE_RLUSD_ACCEPT, sequence: 1, validatedLedgerIndex: 100_000 });
  const { signedTxBlob } = signXrplPayment(WALLET, tx);
  const payload = xrplPaymentPayload(MACROPULSE_RLUSD_ACCEPT, signedTxBlob);
  // 原因そのもの: payload のキーは signedTxBlob と invoiceId の 2 つ。invoiceId は壁の extra.invoiceId の原文（hash ではない）。
  assert.deepEqual(Object.keys(payload).sort(), ["invoiceId", "signedTxBlob"]);
  assert.equal(payload.invoiceId, "97F7BA1328FE4BD8996E10ADC16D1B47");

  const h = encodePaymentHeader({ x402Version: 2, accept: MACROPULSE_RLUSD_ACCEPT, payload, resourceUrl: MACROPULSE_URL });
  const body = JSON.parse(Buffer.from(h.headerValue, "base64").toString("utf8"));
  // t54 の facilitator が isValid:true を返した封筒の形（2026-09-19・未入金の使い捨てウォレットで /verify を実測）。
  assert.deepEqual(body, {
    x402Version: 2,
    resource: { url: MACROPULSE_URL },
    accepted: MACROPULSE_RLUSD_ACCEPT,
    payload: { signedTxBlob, invoiceId: "97F7BA1328FE4BD8996E10ADC16D1B47" },
  });

  // tx 側は現行のまま通る: InvoiceID = SHA-256(invoiceId)・SourceTag・Amount = SendMax・Flags 0・LastLedgerSequence あり・Memo 無し。
  const decoded = decode(body.payload.signedTxBlob) as Record<string, unknown>;
  assert.equal(decoded.InvoiceID, createHash("sha256").update(payload.invoiceId, "utf8").digest("hex").toUpperCase());
  assert.equal(decoded.SourceTag, 804681468);
  assert.deepEqual(decoded.Amount, { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: "0.1" });
  assert.deepEqual(decoded.SendMax, decoded.Amount);
  assert.equal(decoded.Flags, 0);
  assert.equal(decoded.LastLedgerSequence, 100_032);
  assert.equal(decoded.Memos, undefined);
  assert.equal(decoded.NetworkID, undefined, "xrpl:0 には NetworkID を付けない");
});

test("xrplPaymentPayload: extra.invoiceId の無い accept では作らない（invoiceId の無い payload を送る経路を残さない）", () => {
  const { invoiceId: _omit, ...extra } = RLUSD_ACCEPT.extra;
  void _omit;
  assert.throws(() => xrplPaymentPayload({ ...RLUSD_ACCEPT, extra }, "AB"), /no extra\.invoiceId/);
  assert.throws(() => xrplPaymentPayload({ ...RLUSD_ACCEPT, extra: { ...RLUSD_ACCEPT.extra, invoiceId: "" } }, "AB"), /no extra\.invoiceId/);
});
