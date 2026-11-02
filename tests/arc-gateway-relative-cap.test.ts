// ============================================================
// Gateway の価格上限の桁（2026-11-02 資金経路の監査 L-2）。
//
// 別チェーンの免除の上限は、宣言額を台帳の 6 桁へ換算してから比べる。BNB は 18 桁・Stellar は 7 桁。
// 換算できない宣言・桁の分からない network では免除を開かず、宣言額との一致を求める。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARC_GATEWAY_WALLET, selectArcGatewayAccept } from "@/lib/observatory/arc-gateway";
import { ARC_CAIP2, ARC_USDC } from "@/lib/observatory/x402-payer";

const PAY_TO = `0x${"12".repeat(20)}`;

const accept = (amount: string) => ({
  scheme: "exact",
  network: ARC_CAIP2,
  amount,
  asset: ARC_USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_GATEWAY_WALLET },
});
const pick = (amount: string, declaredAmount: string | null, declaredNetwork: string | null) =>
  selectArcGatewayAccept([accept(amount)], {
    nativeArcSignable: false,
    declaredAmount,
    declaredPayTo: PAY_TO,
    declaredNetwork,
    gatewayDeclaredPayTos: [],
  });

test("BNB 先頭: 宣言 0.001 USD1（18 桁）に $1 の accept は通らず、$0.001 以下は通る", () => {
  const declared = "1000000000000000"; // 0.001 USD1
  assert.equal(pick("1000000", declared, "eip155:56").accept, null);
  assert.equal(pick("1001", declared, "eip155:56").accept, null);
  assert.ok(pick("1000", declared, "eip155:56").accept);
  assert.ok(pick("500", declared, "eip155:56").accept);
});

test("BNB 先頭: 6 桁に割り切れない宣言では免除を開かない", () => {
  assert.equal(pick("1000", "1000000000000001", "eip155:56").accept, null);
});

test("Stellar 先頭: 宣言 $0.01（7 桁で 100000）に $0.10 の accept は通らず、$0.01 以下は通る", () => {
  const declared = "100000";
  assert.equal(pick("100000", declared, "stellar:pubnet").accept, null);
  assert.equal(pick("10001", declared, "stellar:pubnet").accept, null);
  assert.ok(pick("10000", declared, "stellar:pubnet").accept);
});

test("6 桁の network は従来どおり（Base・表記ゆれの base・Solana）", () => {
  for (const net of ["eip155:8453", "base", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]) {
    assert.ok(pick("10000", "10000", net).accept, net);
    assert.ok(pick("5000", "10000", net).accept, net);
    assert.equal(pick("10001", "10000", net).accept, null, net);
  }
});

test("桁の分からない network では、宣言額と一致するときだけ", () => {
  assert.equal(pick("500", "1000", "eip155:4663").accept, null);
  assert.ok(pick("1000", "1000", "eip155:4663").accept);
  assert.equal(pick("500", "1000", null).accept, null);
});

test("宣言が Arc なら従来どおり一致のみ。$1 の上限は変わらない", () => {
  assert.ok(pick("1000", "1000", ARC_CAIP2).accept);
  assert.equal(pick("500", "1000", ARC_CAIP2).accept, null);
  assert.equal(pick("1000001", "1000001", "eip155:8453").accept, null);
});
