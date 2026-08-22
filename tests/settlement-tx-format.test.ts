// ============================================================
// 2026-08-23 監査 C-4: L1 の決済ハッシュは売り手の PAYMENT-RESPONSE ヘッダの
// 自己申告で、「空でない文字列」以外を何も見ていなかった。その値が公開台帳の
// tx_hash になり、2026-08-22 以降は observed_purchases 経由でスコアの
// 最上位軸にも流れる。売り手は決済せずに success:true と架空の文字列を返すだけで
// 「決済成功」の行を作れた。
//
// この検査は**権威ではない**（形式が正しい偽ハッシュは通る）。本当の関門は
// オンチェーン照合。ここで固定するのは「明らかにトランザクションIDでないものを
// settled と呼ばない」ことと、「厳しすぎて正直な売り手を誤って告発しない」こと。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";

// 本番実測（2026-08-23）: EVM 491件が66文字・Solana 5件が88文字、不正形式0件。
const REAL_EVM = "0x" + "a".repeat(64);
const REAL_SOL = "5".repeat(88);

test("本番に実在する形（EVM 66文字 / Solana 88文字）は通る", () => {
  assert.equal(isWellFormedSettlementTx(REAL_EVM, "evm"), true);
  assert.equal(isWellFormedSettlementTx(REAL_SOL, "solana"), true);
  // 大文字混じりの16進も本物。誤って弾かない。
  assert.equal(isWellFormedSettlementTx("0x" + "AbCdEf01".repeat(8), "evm"), true);
});

test("売り手が返しうる偽の申告は settled と呼ばれない", () => {
  for (const junk of [
    "ok",
    "settled",
    "true",
    "0x",
    "0x123",                       // 短すぎる
    "0x" + "a".repeat(63),         // 1文字足りない
    "0x" + "a".repeat(65),         // 1文字多い
    "0x" + "z".repeat(64),         // 16進でない
    "a".repeat(64),                // 0x が無い
    "https://example.com/receipt",
    " ",
    "",
  ]) {
    assert.equal(isWellFormedSettlementTx(junk, "evm"), false, `EVMで通ってはいけない: ${junk}`);
  }
  assert.equal(isWellFormedSettlementTx(null, "evm"), false);
  assert.equal(isWellFormedSettlementTx(undefined, "solana"), false);
});

test("チェーンを取り違えたら通さない（EVMハッシュをSolanaと言わない）", () => {
  assert.equal(isWellFormedSettlementTx(REAL_EVM, "solana"), false);
  assert.equal(isWellFormedSettlementTx(REAL_SOL, "evm"), false);
});

test("Solana: base58 に無い文字（0 O I l）は弾く", () => {
  assert.equal(isWellFormedSettlementTx("0".repeat(88), "solana"), false);
  assert.equal(isWellFormedSettlementTx("O".repeat(88), "solana"), false);
  assert.equal(isWellFormedSettlementTx("l".repeat(88), "solana"), false);
});

test("前後の空白は本物を弾く理由にしない", () => {
  assert.equal(isWellFormedSettlementTx(`  ${REAL_EVM}  `, "evm"), true);
});

test("settle_claimed_unverifiable は決済率の分母に入る（不都合な結果を落とさない）", () => {
  // 署名して実際に払った試行なので、ここから外すと自分の公表決済率が
  // 都合よく上がる。分母に入っていることを固定する。
  assert.ok(
    (PAID_ATTEMPT_STATUSES as readonly string[]).includes("settle_claimed_unverifiable"),
    "PAID_ATTEMPT_STATUSES から外れている——公表決済率が甘くなる",
  );
  assert.ok((PAID_ATTEMPT_STATUSES as readonly string[]).includes("settled"));
  assert.ok((PAID_ATTEMPT_STATUSES as readonly string[]).includes("settle_failed"));
});
