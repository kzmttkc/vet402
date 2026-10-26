/**
 * robots.txt が開けた鍵なし読み取りの応答に付ける印（2026-10-26）。
 *
 * /sellers と /api/v1/sellers/export.csv は帰属の見直しが終わるまで noindex。
 * 開けた読み取りは売り手の URL と失敗の状態を含むので、クロールは許したまま
 * 索引には載せない。成功も 400 / 429 / 503 / 308 も同じ印を付ける。
 */
export const X_ROBOTS_TAG = "x-robots-tag";
export const X_ROBOTS_NOINDEX = "noindex";

export function withNoindex(headers: Record<string, string>): Record<string, string> {
  return { ...headers, [X_ROBOTS_TAG]: X_ROBOTS_NOINDEX };
}

export function stampNoindex<T extends Response>(response: T): T {
  response.headers.set(X_ROBOTS_TAG, X_ROBOTS_NOINDEX);
  return response;
}
