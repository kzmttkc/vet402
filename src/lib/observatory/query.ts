export type ObservatoryVerdict = "pass" | "fail" | "unverified";

export type ObservatoryQuery = {
  page: number;
  pageSize: number;
  q: string | null;
  verdict: ObservatoryVerdict | null;
  network: string | null;
  /** 2026-09-02 導線監査 F2: 受領証あり（L1 settled ≥ 1）だけに絞る。`?l1=1` のみ真。 */
  l1: boolean;
};

const VERDICTS = new Set<ObservatoryVerdict>(["pass", "fail", "unverified"]);
const NETWORK_RE = /^[a-z0-9:-]{1,40}$/i;

export function parseObservatorySearchParams(
  params: Record<string, string | undefined>,
): ObservatoryQuery {
  const page = Math.max(1, Math.trunc(Number.parseFloat(params.page ?? "1")) || 1);
  const requestedSize = Math.trunc(Number.parseFloat(params.pageSize ?? "40")) || 40;
  const pageSize = Math.min(Math.max(requestedSize, 1), 100);

  const rawQ = (params.q ?? "").trim().replace(/[%_\\]/g, "").slice(0, 80);
  const q = rawQ.length > 0 ? rawQ : null;

  const rawVerdict = params.verdict ?? "";
  const verdict = VERDICTS.has(rawVerdict as ObservatoryVerdict)
    ? (rawVerdict as ObservatoryVerdict)
    : null;

  const rawNetwork = (params.network ?? "").trim();
  const network = NETWORK_RE.test(rawNetwork) ? rawNetwork : null;

  const l1 = params.l1 === "1";

  return { page, pageSize, q, verdict, network, l1 };
}

/**
 * ページ内リンク（絞り込み・ページ送り）の href。既定値は書かない——
 * `/observatory` が正典 URL で、フィルタ無し・1 頁目はそこへ戻る。
 */
export function observatoryHref(query: ObservatoryQuery, page: number): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (query.q) params.set("q", query.q);
  if (query.verdict) params.set("verdict", query.verdict);
  if (query.network) params.set("network", query.network);
  if (query.l1) params.set("l1", "1");
  const encoded = params.toString();
  return encoded ? `/observatory?${encoded}` : "/observatory";
}
