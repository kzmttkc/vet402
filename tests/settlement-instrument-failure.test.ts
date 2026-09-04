// ============================================================
// 2026-09-04 金の経路監査 P1-3: 計器の故障を売り手の罪にしていた。
//
// `wrong_chain` は「BASE_RPC_URL が Base を指していない」または
// 「SOLANA_RPC_URL が別クラスタを指している」——**我々の設定の事故**であって、
// 売り手についての測定ではない。にもかかわらず TRANSIENT_REASONS に入って
// おらず、恒久の `settle_claim_refuted` として確定していた。RPC を 1 つ差し替え
// 間違えるだけで、その日のバッチ 200 件が全部「決済していない売り手」として
// 公開台帳・公開バッジ・スコアへ流れ、しかも settlement_verified=false が
// 立つので二度と見直されない。
//
// `malformed_tx` も同じ性質: ランナーは isWellFormedSettlementTx を通った
// 行しか settle_claimed にしないので、照合でこれが出るのは我々の側の不整合
// （旧 `settled` 行・チェーン判定の取り違え）を意味する。
//
// 守るもの:
//   1. wrong_chain / malformed_tx で status を倒さない;
//   2. wrong_chain を見たら**そのバッチを中断**する（次の行を見に行かない——
//      同じ壊れた RPC で 200 件を deferred にしても意味が無く、時間だけ使う）;
//   3. どちらも logServerError で fail-loud（黙って deferred を積まない）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSIENT_REASONS } from "@/lib/observatory/settlement-verifier";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

test("wrong_chain は一時的な理由（売り手についての所見ではない）", () => {
  assert.ok(TRANSIENT_REASONS.has("wrong_chain"), "wrong_chain が恒久 refuted のまま");
});

test("malformed_tx も一時的な理由（ランナーは形式検査済みの行しか claimed にしない）", () => {
  assert.ok(TRANSIENT_REASONS.has("malformed_tx"), "malformed_tx が恒久 refuted のまま");
});

test("恒久の否定に残るのは売り手についての所見だけ", () => {
  for (const permanent of [
    "tx_reverted",
    "no_matching_transfer",
    "nonce_not_used",
    "tx_hash_reused",
    "amount_mismatch",
    "payee_mismatch",
    "payer_mismatch",
  ]) {
    assert.ok(!TRANSIENT_REASONS.has(permanent), `${permanent} が一時扱いになっている`);
  }
});

test("wrong_chain を見たらバッチを中断し fail-loud で記録する", () => {
  const v = read("src", "lib", "observatory", "settlement-verifier.ts");
  assert.match(v, /INSTRUMENT_FAILURE_REASONS/, "計器故障の語彙が無い");
  assert.match(
    v,
    /logServerError\(\s*"settlement-verifier\.instrument_failure"/,
    "計器の故障が fail-loud になっていない",
  );
  assert.match(v, /instrumentFailure/, "バッチ中断のフラグが無い");
});
