// ============================================================
// XRPL レーンの固定値（依存なし）。l1-runner の候補 SQL と xrpl402-payer の関門が同じ値を読む。
// xrpl402-payer.ts は `xrpl` パッケージを import するので、フラグ OFF のバンドルに入れないために
// l1-runner からは動的 import しかしない——SQL に要る定数だけをここへ分けた（2026-09-18）。
// ============================================================

/** RLUSD の 40 桁 hex 通貨コード（"RLUSD" を右 0 詰め）。カタログ 1,683 accept がこの形。 */
export const RLUSD_CURRENCY_HEX = "524C555344000000000000000000000000000000";
/** Ripple の RLUSD 発行者（mainnet）。**固定**——壁の extra.issuer がこれと違えば署名しない。 */
export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
