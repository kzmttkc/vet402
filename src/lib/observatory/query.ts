export type ObservatoryVerdict = "pass" | "fail" | "unverified" | "withdrawn";

export type ObservatoryQuery = {
  page: number;
  pageSize: number;
  q: string | null;
  /**
   * q を 80 文字で切った。切ったことは頁に書く。
   * リンクは切った後の q だけだと次の頁で長さが 80 以下になり、切ったことが消える。
   * `qCut=1` を残し、その印だけでも同じ文を出す。
   */
  qTruncated: boolean;
  verdict: ObservatoryVerdict | null;
  network: string | null;
  /** 2026-09-02 導線監査 F2: 受領証あり（L1 settled ≥ 1）だけに絞る。`?l1=1` のみ真。 */
  l1: boolean;
};

const VERDICTS = new Set<ObservatoryVerdict>(["pass", "fail", "unverified", "withdrawn"]);
const NETWORK_RE = /^[a-z0-9:-]{1,40}$/i;

export function parseObservatorySearchParams(
  params: Record<string, string | undefined>,
): ObservatoryQuery {
  const page = Math.max(1, Math.trunc(Number.parseFloat(params.page ?? "1")) || 1);
  const requestedSize = Math.trunc(Number.parseFloat(params.pageSize ?? "40")) || 40;
  const pageSize = Math.min(Math.max(requestedSize, 1), 100);

  // `%` `_` `\` は消さない。ILIKE のワイルドカードには reader の escapeLike がする。
  // 消すと resource の `ltr_` が別の語になり、台帳にある行が 0 件に見える。
  const trimmedQ = (params.q ?? "").trim();
  const rawQ = trimmedQ.slice(0, 80);
  const q = rawQ.length > 0 ? rawQ : null;
  const qTruncated = trimmedQ.length > 80 || params.qCut === "1";

  const rawVerdict = params.verdict ?? "";
  const verdict = VERDICTS.has(rawVerdict as ObservatoryVerdict)
    ? (rawVerdict as ObservatoryVerdict)
    : null;

  const rawNetwork = (params.network ?? "").trim();
  const network = NETWORK_RE.test(rawNetwork) ? rawNetwork : null;

  const l1 = params.l1 === "1";

  return { page, pageSize, q, qTruncated, verdict, network, l1 };
}

/**
 * ページ内リンク（絞り込み・ページ送り）の href。既定値は書かない——
 * `/observatory` が正典 URL で、フィルタ無し・1 頁目はそこへ戻る。
 */
/**
 * 合格率の文に足す絞り込み。付いているものだけを名指す。
 * verdict は率の母数に入らないので、ここには出さない。
 */
export function observatoryRateFilters(query: Pick<ObservatoryQuery, "q" | "network" | "l1">): string | null {
  const names: string[] = [];
  if (query.q) names.push("the search");
  if (query.network) names.push("the network");
  if (query.l1) names.push("the settled filter");
  if (names.length === 0) return null;
  if (names.length === 1) return `This rate includes ${names[0]}.`;
  if (names.length === 2) return `This rate includes ${names[0]} and ${names[1]}.`;
  return `This rate includes ${names[0]}, ${names[1]}, and ${names[2]}.`;
}

export function observatoryHref(query: ObservatoryQuery, page: number): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (query.q) params.set("q", query.q);
  if (query.qTruncated) params.set("qCut", "1");
  if (query.verdict) params.set("verdict", query.verdict);
  if (query.network) params.set("network", query.network);
  if (query.l1) params.set("l1", "1");
  const encoded = params.toString();
  return encoded ? `/observatory?${encoded}` : "/observatory";
}
