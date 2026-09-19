// ============================================================
// 記録用の誤り文字列（2026-09-17 payer-funds.ts で作り、2026-09-19 横断監査 W4 で共有化）。
//
// viem / RPC クライアントの transport エラーは本文に RPC の URL を含み、URL には鍵が
// 入る形（`…/v2/<key>`）がある。SOLANA_RPC_URL・TEMPO_RPC_URL・XRPL_RPC_URL はどれも
// その形を取りうるので、台帳（x402_l1_purchases.raw_response_meta・
// settlement_verify_reason）・summary・サーバログのどこへ書く前にも必ずここを通す。
//
// 置き場をモジュールに分けたのは、payer-funds だけが持っていた 2026-09-19 まで
// l1-runner・settlement-verify・settlement-verify-tempo が素通しだったため
// （payer-funds は重い依存を引くので、書き手がそれを import したくない）。
// ============================================================

/** `https?://…` を `<url>` に伏せ、300 字に切る。 */
export function redactForLog(error: unknown): string {
  return String(error).replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
}
