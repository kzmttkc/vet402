// ============================================================
// 記録用の伏字（2026-09-17 payer-funds.ts で作り、2026-09-19 横断監査 W4 で共有化。
// 同日の独立レビュー W-1 で scheme を広げ、ログ用の包みを足した）。
//
// viem / RPC クライアント / postgres ドライバの誤りは本文に接続先の URL を含み、URL には
// 鍵が入る形（`…/v2/<key>`・`postgres://user:pw@host/db`）がある。SOLANA_RPC_URL・
// TEMPO_RPC_URL・XRPL_RPC_URL・DATABASE_URL はどれもその形を取りうるので、台帳
// （x402_l1_purchases.raw_response_meta・settlement_verify_reason）・summary・**サーバログ**
// のどこへ書く前にも必ずここを通す。
//
// scheme に `wss?` が要る理由（レビュー W-1）: Solana の `Connection` は https の RPC URL から
// WebSocket の endpoint を内部生成するので、エラー本文には `wss://…/v2/<key>` で出る。
//
// 使い分け:
//   redactUrls    文字列から URL を伏せるだけ（長さは切らない）
//   redactForLog  台帳・summary 用。伏せて 300 字に切る（列の長さを決めているのはこちら）
//   redactedError logServerError へ渡す包み。伏せるが切らない（ログの診断を消さない）
//
// 置き場をモジュールに分けたのは、payer-funds だけが持っていた 2026-09-19 まで
// l1-runner・settlement-verify が素通しだったため（payer-funds は Solana / Arc / Tempo の
// client を引くので、書き手がそれを import したくない）。
// ============================================================

const URL_RE = /(https?|wss?|postgres(?:ql)?):\/\/\S+/g;

/** 文字列中の接続 URL を `<url>` に伏せる。長さは変えない。 */
export function redactUrls(text: string): string {
  return text.replace(URL_RE, "<url>");
}

/** 台帳・summary へ書く誤り文字列。伏せてから 300 字に切る。 */
export function redactForLog(error: unknown): string {
  return redactUrls(String(error)).slice(0, 300);
}

/**
 * `logServerError(tag, redactedError(error))` の形で使う包み。
 *
 * logServerError は `error.message` をそのまま console へ出すので、RPC 由来の誤りを
 * 素で渡すと Vercel のログに実鍵が並ぶ（2026-09-19 レビュー W-1: DB 側だけ伏せて
 * ログが素通し、という組み合わせが l1-runner に 3 か所あった）。切らないのは、
 * ログは診断のためにあるから。
 */
export function redactedError(error: unknown): Error {
  return new Error(redactUrls(String(error)));
}
