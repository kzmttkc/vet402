// ============================================================
// 旧スコア（0–100 / ALLOW・WARN・BLOCK）の応答に「非推奨・判定 API を使え」を載せる（2026-09-29）。
//
// 2026-09-29 敵対的監査 4 周目: 非推奨のスコアが x402.ottoai.services の払い先に ALLOW 88 を返し、同じ
// endpoint の判定 API（/api/v1/resources/{resourceId}/decision?role=payer）は WARN（l1_never_delivered）だった。
// 非推奨は llms.txt と docs にしか書かれておらず、スコアの応答そのものは何も言っていなかった。
// **スコアの値は変えない**——移行期間の呼び出し元を黙って壊さない。応答に印を足すだけ。
//
// 載せ方は 2 つ:
//   ヘッダ  Deprecation（RFC 9745: 非推奨になった時刻）と Link rel="deprecation"（説明の在り処）
//   本文    deprecated: true と deprecation（いつから・何を使うか・なぜか）。既存のキーは触らない
// ============================================================
import type { NextResponse } from "next/server";

/** 判定 API が正式な統合になった日（llms.txt / docs の「canonical integration since 2026-09-02」）。 */
export const SCORE_DEPRECATED_SINCE = "2026-09-02";

/** RFC 9745 の Deprecation ヘッダ値（@ + UNIX 秒）。2026-09-02T00:00:00Z。 */
export const SCORE_DEPRECATION_HEADER = `@${Date.UTC(2026, 8, 2) / 1000}`;

export const SCORE_DEPRECATION_LINK = '<https://vet402.com/docs/api#endpoints>; rel="deprecation"; type="text/html"';

export const SCORE_DEPRECATION_NOTICE = {
  since: SCORE_DEPRECATED_SINCE,
  use_instead: "GET /api/v1/resources/{resourceId}/decision?role=payer (before paying) or ?role=payee&payer={address} (before serving)",
  find_resource_id: "GET /api/v1/resolve?q={endpoint URL}",
  message:
    "This 0-100 score is deprecated and kept for callers migrating off it; its value is unchanged. It rates a wallet or agent as a whole, not the endpoint in front of you, and it is not the rule vet402 maintains, so it can say ALLOW where the decision for an endpoint paid to the same wallet says WARN or BLOCK. Decide with the decision endpoint (use_instead), not with this score.",
} as const;

/** 本文の先頭に 2 キーを足す（読み手が最初に目にする位置）。既存キーの値は上書きしない。 */
type ScoreDeprecationFields = { deprecated: true; deprecation: typeof SCORE_DEPRECATION_NOTICE };

export function withScoreDeprecationBody<T extends object>(body: T): Omit<ScoreDeprecationFields, keyof T> & T {
  return { deprecated: true as const, deprecation: SCORE_DEPRECATION_NOTICE, ...body };
}

/** ヘッダに Deprecation と Link を足す（既存の Link があれば後ろへ連ねる）。 */
export function withScoreDeprecationHeaders<R extends NextResponse>(res: R): R {
  res.headers.set("Deprecation", SCORE_DEPRECATION_HEADER);
  const link = res.headers.get("Link");
  res.headers.set("Link", link ? `${link}, ${SCORE_DEPRECATION_LINK}` : SCORE_DEPRECATION_LINK);
  return res;
}
