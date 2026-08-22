// ============================================================
// vet402 Observatory — operator (self) identity.
//
// vet402 will itself be listed in the public x402 catalog once the self-listing
// endpoint ships (WO(c)). Two things must then hold, and both trace back to one
// question — "is this payTo our own?":
//   1. the L1 buyer must never purchase from our own payTo (an on-chain
//      self-transfer dressed up as a "settle-through verified" receipt would
//      make the neutrality that is the whole moat a lie) — enforced in
//      l1-runner via this denylist;
//   2. the public read surfaces must MARK our own endpoint as the operator's
//      and exclude it from the aggregate rates, so vet402 is never counted as a
//      neutral third party in its own measurements — enforced in reader.ts.
//
// Kept in this dependency-light module (no signing / fetch / drizzle imports)
// so the public read path can ask "is this ours?" without pulling the whole L1
// purchasing stack into a page render.
//
// VET402_OPERATOR_PAYTO はカンマ区切りの追加リスト。アドレスは小文字化して
// 大小無視で比較する。
//
// 2026-08-23 監査: **本番に VET402_OPERATOR_PAYTO が設定されておらず、この
// denylist は空＝完全な no-op だった。** 「自分で自分を検証していない」という
// 中立性の保証が、手入力の環境変数1本に依存していて、実際に入っていなかった。
// 中立性は vet402 の堀そのものなので、忘れられる場所に置いてはいけない。
//
// 直し方: **署名鍵から自動導出する**。L1 の支払いウォレット（EVM アカウント /
// Solana 公開鍵）は我々が鍵を握っているアドレスなので、そこへ払う購入は定義上
// 自己取引になる。導出は `addDerivedOperatorAddresses` で実行時に注入し、
// 環境変数のリストと合併する——設定を書き忘れても堀は消えない。
// このモジュールは依存を持たない（署名・fetch・drizzle を import しない）まま
// にして、公開の読み取り経路が L1 スタックを引きずり込まずに
// 「これは我々のか？」を聞けるようにしている。
// ============================================================

/**
 * 署名鍵から導出した運営者アドレス。プロセス内で L1 ランナーが起動時に注入する。
 * 環境変数と違い、書き忘れが起き得ない。
 */
const derived = new Set<string>();

/**
 * 実際に署名する（＝我々が鍵を握る）アドレスを登録する。L1 ランナーが鍵を
 * 読んだ直後に呼ぶ。小文字化するのは EVM のみ——base58 は小文字化すると壊れる
 * ので原文のまま入れ、比較時に両形を見る。
 */
export function addDerivedOperatorAddresses(addresses: readonly (string | null | undefined)[]): void {
  for (const a of addresses) {
    if (typeof a !== "string") continue;
    const t = a.trim();
    if (t.length === 0) continue;
    derived.add(t);
    derived.add(t.toLowerCase());
  }
}

/** テスト用。プロセス内状態を初期化する。 */
export function resetDerivedOperatorAddresses(): void {
  derived.clear();
}

export function operatorPayToDenylist(): string[] {
  const fromEnv = (process.env.VET402_OPERATOR_PAYTO ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  return [...new Set([...fromEnv, ...derived])];
}

/** True iff `payTo` is an operator-controlled (vet402's own) receiving address. */
export function isOperatorPayTo(payTo: string | null | undefined): boolean {
  if (!payTo) return false;
  const list = operatorPayToDenylist();
  const raw = payTo.trim();
  return list.includes(raw) || list.includes(raw.toLowerCase());
}
