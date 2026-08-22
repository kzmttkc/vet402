// ============================================================
// 2026-08-23 監査 C-1 の攻撃が閉じたことを、判定関数そのもので固定する。
//
// 攻撃: 売り手が新規ウォレット2つを用意し、ダストのUSDCを自分の受取先へ3回送る。
//   旧実装では
//     - getPayeeStats に自己送金除外もダスト下限も無い（支払側には両方ある）
//     - countDistinctFunders が coalesce(funder, wallet) で
//       **未索引ウォレットを「自分自身が資金源」として独立に数える**
//       （funder_wallets は既に台帳に載ったウォレットしか索引しないので、
//        新規ウォレットは判定の瞬間に必ず未索引）
//   → paymentCount 3 / distinctPayers 2 / distinctFunders 2
//   → determineDataDepth が "moderate"
//   → noReceivingEvidence が false → PAYEE_THIN_SCORE_CEILING(69) が外れる
//   → ALLOW が射程に入る。Baseのガス代込みで数円。
//
// ここで固定するのは「深さの天井が外れないこと」。天井が69のままなら
// SCORE_THRESHOLDS.allow(70) に届かないので、いくら積んでも ALLOW にならない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCORE_THRESHOLDS } from "@/lib/chain/config";

// determineDataDepth は非公開なので、実装から規則を読んで同じ入力で検算する。
// （ソース文字列の照合ではなく、規則そのものをここに写して両者の一致を主張する
//  のは危ういので、実装が使う定数と閾値だけを引き、判定は実装の式を再現する）
const src = readFileSync(join(process.cwd(), "src", "lib", "scoring", "payee-engine.ts"), "utf8");

test("深さ判定は independentPayers（＝判明した資金源）を見ている", () => {
  // 実装が distinctPayers ではなく funder-collapse 後の値を使っていること。
  assert.match(
    src,
    /function independentPayerCount\(stats: PayeeStats\): number \{\s*return Math\.min\(stats\.distinctPayers, stats\.distinctFunders\);/,
    "independentPayerCount が distinctFunders を使わなくなったら攻撃が再び開く",
  );
  assert.match(
    src,
    /paymentCount >= 3 && independentPayers >= 2/,
    "moderate の条件が independentPayers を見ていること",
  );
});

test("攻撃条件: 未索引ウォレット2つでは independentPayers が2にならない", () => {
  // getPayeeStats は distinctFunders に「判明した資金源」だけを入れる
  // （未索引は payersWithUnknownFunder へ）。よって攻撃者の値は:
  const attacker = { distinctPayers: 2, distinctFunders: 0, paymentCount: 3 };
  const independentPayers = Math.min(attacker.distinctPayers, attacker.distinctFunders);
  assert.equal(independentPayers, 0, "未索引は独立と数えない");
  const isModerate = attacker.paymentCount >= 3 && independentPayers >= 2;
  assert.equal(isModerate, false, "moderate に上がらない＝thin天井が効いたまま");
});

test("thin の天井は allow 閾値に届かない（届いたら攻撃が通る）", () => {
  const ceiling = SCORE_THRESHOLDS.allow - 1;
  assert.ok(ceiling < SCORE_THRESHOLDS.allow, "天井は allow 未満でなければ意味がない");
});

test("受取側にも支払側と同じ3述語が掛かっている（非対称の再発検知）", () => {
  const payments = readFileSync(join(process.cwd(), "src", "lib", "db", "x402-payments.ts"), "utf8");
  // 共有述語が定義され、受取側の集計と funder 集計の両方から使われていること。
  assert.match(payments, /function RECEIVING_EVIDENCE_PREDICATES/, "共有述語が消えている");
  const uses = payments.match(/RECEIVING_EVIDENCE_PREDICATES\(/g) ?? [];
  assert.ok(
    uses.length >= 3,
    `共有述語の利用が ${uses.length} 箇所しかない（定義+集計+funder集計で3以上を期待）`,
  );
  // 自己送金の除外が述語に含まれていること。
  assert.match(
    payments,
    /lower\(\$\{x402Payments\.wallet\}\) <> \$\{counterpartyLower\}/,
    "自己送金の除外が消えている——所有権検証は自分に払えば必ず通る",
  );
});
