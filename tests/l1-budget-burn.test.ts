// ============================================================
// 2026-09-04 金の経路監査 P1-2: 予約後に throw する経路で予算が焼け、冷却も効かない。
//
// reserveSpend は署名の**前**に spent_units を立てる（正しい——署名済み
// EIP-3009 は validBefore まで生きた金）。だから予約の後で例外が飛ぶと、
// 一円も動いていないのに日次 $25 の観測予算だけが減り、行は in_flight のまま
// 残る。in_flight は冷却（NON_SETTLING_COOLDOWN_STREAK）のどの status にも
// 該当しないので、同じ売り手に何度でも同じことをさせられる。
//
// 実測した焼け方は 2 つ。どちらも売り手が 402 の中身を選ぶだけで起こせる:
//
//  1. `maxTimeoutSeconds: 120.5` → buildAuthorization の window が小数になり
//     validBefore が "1757000120.5" → signX402Payment の BigInt() が throw。
//  2. payTo が**大小混在で EIP-55 チェックサムが合わない**文字列
//     → viem の validateTypedData は isAddress(value)（strict 既定）で検査するので
//     InvalidAddressError。全小文字は通る（isAddress は小文字なら true）ので、
//     正直な売り手を巻き込まない。
//     ※ 監査メモは isAddress(payTo, {strict:false}) と書いていたが、それでは
//       この形を通してしまう（viem 2.55 の実測。node_modules/viem/_esm/utils/
//       typedData.js の validateTypedData → isAddress(value) は strict 既定）。
//       **署名器が使うのと同じ述語**でなければ関門にならないので strict のまま使う。
//  3. Solana は payTo が base58 として parse できない / off-curve（PDA）だと
//     PublicKey / getAssociatedTokenAddressSync が throw。
//
// どれも「予約より前」に落とせる。落とせば予算は減らず、行も残らない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { buildAuthorization, selectAccept, BASE_USDC, BASE_CAIP2 } from "@/lib/observatory/x402-payer";
import { selectSolanaAccept, SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";

const PAY_TO_LOWER = "0x1304ec1a8945365e43a5c18a734065f107b417ca";
/** 同じ 20 バイトだが EIP-55 チェックサムが合わない大小混在（viem は throw する）。 */
const PAY_TO_BAD_CHECKSUM = "0x1304Ec1a8945365E43a5c18A734065F107B417cA";

const evmAccept = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: BASE_CAIP2,
  amount: "3000",
  asset: BASE_USDC,
  payTo: PAY_TO_LOWER,
  maxTimeoutSeconds: 300,
  ...over,
});

const evmOpts = { declaredAmount: "3000", declaredPayTo: null };

test("buildAuthorization: 小数の maxTimeoutSeconds でも validBefore は整数", () => {
  const now = 1_757_000_000;
  const a = buildAuthorization({ from: PAY_TO_LOWER, to: PAY_TO_LOWER, value: "1", nowSec: now, maxTimeoutSeconds: 120.5 });
  assert.doesNotThrow(() => BigInt(a.validBefore), "validBefore が BigInt に通らない（署名器が throw する）");
  assert.doesNotThrow(() => BigInt(a.validAfter));
});

test("buildAuthorization: 小数の nowSec でも整数", () => {
  const a = buildAuthorization({ from: PAY_TO_LOWER, to: PAY_TO_LOWER, value: "1", nowSec: 1_757_000_000.7 });
  assert.doesNotThrow(() => BigInt(a.validBefore));
  assert.doesNotThrow(() => BigInt(a.validAfter));
});

test("P2: 認可の有効期間は最大 120 秒（従来は 600 秒）", () => {
  const now = 1_757_000_000;
  for (const mts of [undefined, 60, 300, 600, 100_000]) {
    const a = buildAuthorization({ from: PAY_TO_LOWER, to: PAY_TO_LOWER, value: "1", nowSec: now, maxTimeoutSeconds: mts });
    assert.ok(Number(a.validBefore) <= now + 120, `maxTimeoutSeconds=${mts} で ${Number(a.validBefore) - now}s`);
    assert.ok(Number(a.validBefore) > now);
  }
});

test("署名できない maxTimeoutSeconds の accept は予約より前に no_eligible_accept", () => {
  const r = selectAccept([evmAccept({ maxTimeoutSeconds: 120.5 })], evmOpts);
  assert.equal(r.accept, null);
  assert.equal(r.reason, "no_eligible_accept");
});

test("チェックサムの合わない payTo は予約より前に no_eligible_accept", () => {
  const r = selectAccept([evmAccept({ payTo: PAY_TO_BAD_CHECKSUM })], evmOpts);
  assert.equal(r.accept, null);
  assert.equal(r.reason, "no_eligible_accept");
});

test("全小文字の payTo は従来どおり通る（正直な売り手を巻き込まない）", () => {
  const r = selectAccept([evmAccept()], evmOpts);
  assert.equal(r.reason, null);
  assert.equal(r.accept?.payTo, PAY_TO_LOWER);
});

test("正しくチェックサム化された payTo も通る", () => {
  const r = selectAccept([evmAccept({ payTo: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })], evmOpts);
  assert.equal(r.reason, null);
});

const SOL_PAY_TO = "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM";
const SOL_FEE_PAYER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const solAccept = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: SOLANA_MAINNET_CAIP2,
  amount: "1000",
  asset: SOLANA_USDC_MINT,
  payTo: SOL_PAY_TO,
  extra: { feePayer: SOL_FEE_PAYER },
  ...over,
});
const solOpts = { declaredAmount: "1000", declaredPayTo: null, payerAddress: Keypair.generate().publicKey.toBase58() };

test("base58 として不正な payTo は予約より前に no_eligible_accept（Solana）", () => {
  const r = selectSolanaAccept([solAccept({ payTo: "0IlO-not-base58" })], solOpts);
  assert.equal(r.accept, null);
  assert.equal(r.reason, "no_eligible_accept");
});

test("off-curve（PDA）の payTo は予約より前に no_eligible_accept（Solana）", () => {
  // ATA は必ず off-curve。宛先に指定されると getAssociatedTokenAddressSync が throw する。
  const pda = "8t8mYRK1dEA9zvGdZTgcqUwx1kwbnUDVAnGZTPX3TqrM";
  const r = selectSolanaAccept([solAccept({ payTo: pda })], solOpts);
  assert.equal(r.accept, null);
  assert.equal(r.reason, "no_eligible_accept");
});

test("正常な base58 の payTo は通る（Solana）", () => {
  const r = selectSolanaAccept([solAccept()], solOpts);
  assert.equal(r.reason, null);
});

// ------------------------------------------------------------
// 予約より後の防御（source 検査）。
// 予約後に何が飛んでも、行は in_flight のまま置かない。
// ------------------------------------------------------------
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

test("署名〜記帳は try/catch に包まれ、throw 時は settle_failed へ倒す", () => {
  const runner = read("src", "lib", "observatory", "l1-runner.ts");
  assert.match(runner, /resolveReservationAsFailed/, "予約の失敗解決が無い");
  assert.match(
    runner,
    /catch \(error\) \{[\s\S]{0,400}resolveReservationAsFailed/,
    "署名〜記帳の throw を捕まえて解決していない",
  );
});

test("孤児 in_flight の解決先（request_error）が冷却の対象 status に入っている", () => {
  const runner = read("src", "lib", "observatory", "l1-runner.ts");
  // 冷却判定の IN(...) に request_error が含まれること。
  const cooldown = /pu\.status IN \(([\s\S]*?)\)/.exec(runner);
  assert.ok(cooldown, "冷却の status リストが見つからない");
  assert.match(cooldown[1], /'request_error'/, "sweepOrphanedInFlight の解決先が冷却対象に入っていない");
  assert.match(cooldown[1], /'settle_failed'/);
});
