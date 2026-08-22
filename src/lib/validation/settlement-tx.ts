// ============================================================
// 決済トランザクション識別子の形式検査（2026-08-23 監査）。
//
// なぜ要るか: L1 の決済ハッシュは `PAYMENT-RESPONSE` ヘッダを base64 デコードした
// 売り手の**自己申告**で、`parseSettlementResponse` は「空でない文字列」以外を
// 何も見ていなかった。その値がそのまま公開台帳の tx_hash になり、2026-08-22 に
// observed_purchases 経由でスコアの最上位軸へも流れるようになった。
// 売り手は決済せずに `success:true` と架空の文字列を返すだけで「決済成功」の行を
// 作れる状態だった（本番実測 2026-08-23 時点では悪用の痕跡なし——
// EVM 491件が66文字・Solana 5件が88文字で全件正しい形）。
//
// **この検査は権威ではない。** 形式が正しいだけの偽ハッシュは通る。
// 本当の関門はオンチェーン照合（宛先・金額・トークン・チェーン・確定数）で、
// それが入るまでの間、公開面では「売り手申告＋形式検査済み・オンチェーン照合は導入中」
// と正直に書く。ここでやるのは「明らかにトランザクションIDでないもの」を弾くこと。
//
// 意図的に緩い: 厳しすぎる検査は正直な売り手を誤って `settle_claimed_unverifiable`
// と告発する。誤検知の代償（信頼の喪失・回復不能）は、ゴミを1つ通す代償より重い。
// ============================================================

/** EVM: 0x + 32バイトの16進。 */
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Solana: base58（0/O/I/l を含まないアルファベット）の署名。
 * ed25519 署名は64バイト = base58 で通常87〜88文字。先頭ゼロバイトで短くなるため
 * 下限に余裕を持たせる。本番実測（2026-08-23）は5件すべて88文字。
 */
const SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export type SettlementChain = "evm" | "solana";

/**
 * 申告された決済識別子が、そのチェーンのトランザクションIDとして**あり得る形**か。
 * true でも「決済された」ことは意味しない（オンチェーン照合が別途要る）。
 */
export function isWellFormedSettlementTx(
  tx: string | null | undefined,
  chain: SettlementChain,
): boolean {
  if (typeof tx !== "string") return false;
  const trimmed = tx.trim();
  if (trimmed.length === 0) return false;
  return chain === "solana" ? SOLANA_SIG_RE.test(trimmed) : EVM_TX_RE.test(trimmed);
}
