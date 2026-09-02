// ============================================================
// 2026-08-23 監査 C-4 の本丸: settled の定義を
//   「売り手が success:true と何かの文字列を返した」
// から
//   「我々がチェーンで確認した」
// へ置き換えたことを固定する。
//
// 照合器そのものは本番の実レシート6件で検証済み（2026-08-23・確定数約87,000）。
// 対照実験として、期待金額を1単位ずらす／宛先を別アドレスにすると
// no_matching_transfer で落ちることも実測した——つまりゴム印ではない。
// ここで守るのは、その規律がコードから外れないこと。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";
import { REQUIRED_CONFIRMATIONS } from "@/lib/observatory/settlement-verify";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

test("購入バッチは settled を名乗らない（照合を経ないと昇格しない）", () => {
  const runner = read("src", "lib", "observatory", "l1-runner.ts");
  assert.match(
    runner,
    /\? "settle_claimed"/,
    "購入直後の status が settle_claimed でない——売り手の主張を settled と呼んでいる",
  );
  // 購入経路から settled を直接立てていないこと
  assert.doesNotMatch(
    runner,
    /claimedAndWellFormed\s*\n?\s*\?\s*"settled"/,
    "購入経路が settled を直接立てている",
  );
});

test("スコア証拠を書くのは照合器だけ（購入バッチは書かない）", () => {
  const runner = read("src", "lib", "observatory", "l1-runner.ts");
  const verifier = read("src", "lib", "observatory", "settlement-verifier.ts");
  // runner の import は残っていてよいが、呼び出しは無いこと
  const calls = runner.match(/await recordObservedPurchase\(/g) ?? [];
  assert.equal(calls.length, 0, "購入バッチが未照合の主張をスコア証拠に書いている");
  assert.match(verifier, /await recordObservedPurchase\(/, "照合器が証拠を書いていない");
});

test("照合は4条件すべての一致を要求する（どれか1つでも外れたら通さない）", () => {
  const v = read("src", "lib", "observatory", "settlement-verify.ts");
  for (const [what, re] of [
    ["トークン", /log\.address\?\.toLowerCase\(\) !== usdcLower/],
    ["送信元", /topicToAddress\(from\) !== payerLower/],
    ["宛先", /topicToAddress\(to\) !== payToLower/],
    ["金額", /value === expectedValue/],
  ] as const) {
    assert.match(v, re, `${what}の照合が消えている`);
  }
});

test("チェーンIDを毎回確認する（BASE_RPC_URL が別チェーンを指していても気づく）", () => {
  const v = read("src", "lib", "observatory", "settlement-verify.ts");
  assert.match(v, /client\.getChainId\(\)/, "チェーンIDの確認が消えている");
  assert.match(v, /reason: "wrong_chain"/, "チェーン不一致の理由が消えている");
});

test("確定数を要求する（reorgで消えたtxを確認済みと刻まない）", () => {
  assert.ok(REQUIRED_CONFIRMATIONS > 0n, "確定数の要求が0になっている");
  const v = read("src", "lib", "observatory", "settlement-verify.ts");
  assert.match(v, /insufficient_confirmations/, "確定数の判定が消えている");
});

test("一時的な失敗を「否定」に変えない", () => {
  const j = read("src", "lib", "observatory", "settlement-verifier.ts");
  for (const r of ["rpc_unavailable", "tx_not_found", "insufficient_confirmations", "chain_not_yet_verifiable"]) {
    assert.ok(j.includes(`"${r}"`), `${r} が一時扱いから外れている`);
  }
  assert.match(j, /TRANSIENT_REASONS/, "一時/恒久の区別そのものが消えている");
});

test("未照合・照合失敗も決済率の分母に入る（都合の悪い結果を落とさない）", () => {
  const s = PAID_ATTEMPT_STATUSES as readonly string[];
  for (const st of ["settled", "settle_claimed", "settle_claim_refuted", "settle_failed"]) {
    assert.ok(s.includes(st), `${st} が分母から外れている——公表決済率が甘くなる`);
  }
});

test("Solana は「未照合」と言い、偽物とは言わない", () => {
  const v = read("src", "lib", "observatory", "settlement-verify.ts");
  assert.match(v, /chain_not_yet_verifiable/, "Solana を別扱いする理由が消えている");
});

// 2026-09-02 監査 P1-7: ERC-8004 Validation Registry へ書く verdict も同じ規律に従う。
// 購入バッチ（自己申告の時点）からは発火せず、照合器の settled / refuted 確定後にだけ発火する。
test("Registry hook は購入バッチから発火しない（自己申告をオンチェーンに書かない）", () => {
  const runner = read("src", "lib", "observatory", "l1-runner.ts");
  assert.doesNotMatch(runner, /fireL1RegistryHook\(/, "l1-runner が売り手の自己申告で Registry hook を呼んでいる");
  assert.doesNotMatch(runner, /fireL2RegistryHook\(/, "l1-runner が settled 確定前に L2 の Registry hook を呼んでいる");
  const verifier = read("src", "lib", "observatory", "settlement-verifier.ts");
  assert.match(verifier, /fireL1RegistryHook/, "照合器が Registry hook を持っていない");
  assert.match(verifier, /fireL2RegistryHook/, "照合器が L2 の Registry hook を持っていない");
});
