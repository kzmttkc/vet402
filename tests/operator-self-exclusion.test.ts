// ============================================================
// 2026-08-23 監査: 運営者の自己除外が VET402_OPERATOR_PAYTO の手入力だけに
// 依存しており、**本番では未設定＝完全な no-op** だった（`vercel env ls production`
// で実測）。「自分で自分を検証していない」という中立性は vet402 の堀そのもので、
// 手で書き忘れられる場所に置いてはいけない。
//
// 直し方は署名鍵からの自動導出。ここで固定するのは「環境変数が空でも、
// 実際に署名するアドレスへの支払いは自己取引として弾かれる」こと。
// ============================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  addDerivedOperatorAddresses,
  isOperatorPayTo,
  operatorPayToDenylist,
  resetDerivedOperatorAddresses,
} from "@/lib/observatory/operator";

const EVM = "0x24d5DD87fB24eC4D923b9c1D1d0dDedD8eeD037d";
const SOL = "34CMQ3HB3aDWPxwAbLSbQPrBtrFhi354zAsfbb3z5v2z";

beforeEach(() => {
  resetDerivedOperatorAddresses();
  delete process.env.VET402_OPERATOR_PAYTO;
});

test("環境変数が空でも、署名鍵から導出したアドレスは自己取引として弾かれる", () => {
  assert.equal(isOperatorPayTo(EVM), false, "導出前は当然通る");
  addDerivedOperatorAddresses([EVM, SOL]);
  assert.equal(isOperatorPayTo(EVM), true, "EVM の支払いウォレットへの支払いは自己取引");
  assert.equal(isOperatorPayTo(SOL), true, "Solana も同じ");
});

test("EVM は大小無視で一致する（壁が別の表記で返しても抜けない）", () => {
  addDerivedOperatorAddresses([EVM]);
  assert.equal(isOperatorPayTo(EVM.toLowerCase()), true);
  assert.equal(isOperatorPayTo(EVM.toUpperCase().replace("0X", "0x")), true);
});

test("base58 は小文字化で壊れるので原文でも一致する", () => {
  addDerivedOperatorAddresses([SOL]);
  // 小文字化した base58 は別アドレス。原文の比較が効いていることを固定する。
  assert.equal(isOperatorPayTo(SOL), true);
});

test("環境変数のリストと導出分は合併される（片方だけにしない）", () => {
  process.env.VET402_OPERATOR_PAYTO = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  addDerivedOperatorAddresses([EVM]);
  const list = operatorPayToDenylist();
  assert.ok(list.includes("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), "env 分が消えている");
  assert.ok(list.includes(EVM.toLowerCase()), "導出分が消えている");
});

test("無関係な売り手は弾かれない（誤爆しない）", () => {
  addDerivedOperatorAddresses([EVM, SOL]);
  assert.equal(isOperatorPayTo("0x36038e1d712c5e39f35952164ec58ec2b96caee7"), false);
  assert.equal(isOperatorPayTo(null), false);
  assert.equal(isOperatorPayTo(""), false);
});
