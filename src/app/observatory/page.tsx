import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { TableScroll } from "@/components/site/TableScroll";
import { buttonClass } from "@/components/ui/Button";
import { getObservatoryOverviewCached, getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { parseObservatorySearchParams, observatoryHref, observatoryRateFilters } from "@/lib/observatory/query";
import { networkFilterCellLabel, networkFilterCellTitle } from "@/lib/observatory/chains";
import TrackView from "@/components/site/TrackView";
import { L1Ratio, VerdictShareBar, VerdictWord } from "@/components/site/Figures";
import { l0BandFromStats, l0BandFromVerdictCounts } from "@/lib/observatory/l0-band";
import { withdrawnBandCountSentence } from "@/lib/observatory/l0-verdict";
import { WideColumn } from "@/components/site/WideColumn";

/**
 * /observatory — the L0 fact table over the x402 catalog (design §5).
 *
 * What this page is NOT: a ranking, a score, or an opinion. Every cell is a
 * measurement with a definition (see /observatory/methodology): the catalog
 * said X, the payment wall answered Y. The verdict vocabulary is closed —
 * pass / fail / unverified / withdrawn — and a fail only appears after the publication
 * gate (two consecutive failing probes), because a single blip must never
 * brand an endpoint dead in public.
 *
 * NO loading.tsx AT THIS SEGMENT, DELIBERATELY (2026-08-26 L2 UX audit #7 —
 * ソフト404修正). It used to exist purely for this page's own loading
 * skeleton, but a segment-level loading.tsx wraps every nested route
 * (/observatory/state, /observatory/e/[id]) in an inherited <Suspense>
 * boundary too, and that inherited boundary is what made a missing
 * /observatory/e/[id] endpoint respond HTTP 200 instead of 404 (full
 * root-cause note in that page). This page still renders correctly without
 * it — a cold ISR miss just blocks server-side instead of showing a skeleton
 * first, same as every other route in this app without its own loading.tsx
 * (e.g. /blog). Do not re-add a loading.tsx here without re-verifying
 * /observatory/e/[id]'s 404 status with `next build && next start`.
 */

export const metadata: Metadata = pageMetadata({
  title: "x402 Observatory of agent payments",
  description:
    "Daily measurements over the public x402 catalog: does each endpoint's payment wall answer a valid 402 challenge, and is it still listed. Facts, no scores. The same measurements cover x402 agent payments.",
  path: "/observatory",
});

export const revalidate = 600;

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";
}

export default async function ObservatoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    q?: string;
    verdict?: string;
    network?: string;
    pageSize?: string;
    l1?: string;
  }>;
}) {
  const params = await searchParams;
  const query = parseObservatorySearchParams(params);
  const overview = await getObservatoryOverviewCached(query);
  // 2026-09-02 UX 監査: 既定表示の上位 20 行が全部 unverified（登録の 84%）で、初見の人が
  // 「測れていない製品」と読んだ。判定ごとの件数を表の直上に出し、1 クリックで絞れるようにする。
  const stats = await getObservatoryStatsCached().catch(() => null);
  const totalPages = Math.max(1, Math.ceil(overview.totalEndpoints / overview.pageSize));
  const page = overview.page;
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  // ItemList reflects only this page's rows — position accounts for the
  // page offset so it stays truthful about rank within the full register,
  // not a re-numbered 1..N per page.
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "x402 Observatory — observed endpoints",
    numberOfItems: overview.totalEndpoints,
    itemListElement: overview.rows.map((row, i) => ({
      "@type": "ListItem",
      position: (page - 1) * overview.pageSize + i + 1,
      url: `${SITE_URL}/observatory/e/${row.id}`,
      name: row.resourceKey,
    })),
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Observatory", path: "/observatory" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="observatory_view" />
      <article className="sheet sheet-wide">
        <WideColumn />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListJsonLd) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Register: x402 endpoints, L0 · L1</span>
            <span className="doc-asof">
              {overview.latestSnapshot ? (
                <>
                  {/* 1 行に収める（"Catalog snapshot: … (N of N fetched)" は 2 行に折れていた）。数字はそのまま。 */}
                  {/* 2026-09-04 監査 E: 「16,260 / 16,182」は何割る何か分からず、しかも左が大きい。
                      左は catalog-source.ts の fetchedCount＝ページ横断で受け取った生件数（resource_key
                      で重複を畳む前）、右は totalCount＝カタログが pagination.total で自己申告した総数。
                      重複 URL が正規化で 1 本に畳まれるので、生件数が総数を超えうる。語で言う。 */}
                  {/* 2026-09-19 レビュー W8: この行は Bazaar の snapshot だけを出す
                      （reader が主カタログを名指しで取るようになった）。何のカタログの
                      取得健全性かを書かないと、頁の総数（MPP ディレクトリの行も含む）の
                      取得状況だと読まれる。 */}
                  Bazaar catalog snapshot{" "}
                  <span className="text-signal">{overview.latestSnapshot.snapshotDate}</span>{" "}
                  <span
                    title={`${overview.latestSnapshot.fetchedCount.toLocaleString()} entries fetched by vet402 from the CDP x402 Bazaar out of the ${overview.latestSnapshot.totalCount.toLocaleString()} that catalog reports about itself. Fetched counts raw items across pages before duplicate URLs collapse into one key, so it can exceed the reported total. The register also lists endpoints from the MPP directory and the Circle x402 discovery, which are fetched separately. /observatory/state prints each catalog's own as-of line. See section 2.`}
                  >
                    · fetched {overview.latestSnapshot.fetchedCount.toLocaleString()} of catalog{" "}
                    {overview.latestSnapshot.totalCount.toLocaleString()}
                  </span>
                </>
              ) : (
                "Catalog snapshot: none yet"
              )}
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory/state" className="underline">
                State of x402
              </Link>
              {" · "}
              <Link href="/observatory/methodology" className="underline">
                Methodology
              </Link>
            </span>
            <span>Table: L0 verdicts and L1 purchases</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">The x402 Observatory</h1>
        {/* 2026-08-23 UX: 表が何であるかを、Abstract を読む前に1行で言う。
            RFC の版面を壊さないよう新しい枠は足さず、表題直下の弱いインクの
            1行として置く。 */}
        <p className="mt-2 text-brand-lift">
          This page lists live endpoint checks. Values here are measurements, not opinions.
        </p>
        <p className="mt-2 max-w-[62ch] text-brand">
          Counts by chain are on{" "}
          <Link href="/x402/chains" className="doc-link">
            x402 payments by chain
          </Link>
          .{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            Check a seller before paying
          </Link>
          .
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        {/* 2026-09-02 デザイン監査 P1: 1280×800 で最初の画面に操作対象が無かった（検索 y=831・
            図 y=1046・表 y=1177、Abstract 11 行が y=766–1140）。rule-double の直下を
            検索 → Figure 1 → §1 表にし、Abstract は §2「Reading this table」の冒頭へ移す（文は同じ）。 */}
        <form method="get" action="/observatory" className="mt-6">
          <p className="doc-caption">Find an endpoint</p>
          {query.l1 && <input type="hidden" name="l1" value="1" />}
          {query.qTruncated && <input type="hidden" name="qCut" value="1" />}
          {/* 390px: 4 段積み（266px）だと Figure 1 が最初の画面に入らない。Contains を 1 行、
              L0 / Network / Apply を 2 行目に並べる。 */}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block min-w-0 basis-full text-[0.84375rem] sm:basis-auto sm:flex-1">
              <span className="doc-caption block">Contains</span>
              <input
                name="q"
                type="search"
                defaultValue={query.q ?? ""}
                className="doc-input mt-1 max-sm:text-[1.0625rem]"
              />
            </label>
            <label className="block text-[0.84375rem]">
              <span className="doc-caption block">L0</span>
              <select
                name="verdict"
                defaultValue={query.verdict ?? ""}
                className="doc-input mt-1 max-sm:text-[1.0625rem]"
              >
                <option value="">any</option>
                <option value="pass">pass</option>
                <option value="fail">fail</option>
                <option value="unverified">unverified</option>
                <option value="withdrawn">withdrawn</option>
              </select>
            </label>
            <label className="block min-w-0 flex-1 text-[0.84375rem] sm:min-w-[16ch] sm:flex-none">
              <span className="doc-caption block">Network</span>
              <input
                name="network"
                defaultValue={query.network ?? ""}
                placeholder="eip155:8453"
                className="doc-input mt-1 max-sm:text-[1.0625rem]"
              />
            </label>
            {/* 2026-08-23 UX: underline のテキストリンクに見えており、フィルタを
                確定する主操作だと分からなかった。既存の buttonClass（紙面の
                ボタン表現）へ寄せる——新しい色も角丸も足していない。 */}
            <button type="submit" className={buttonClass({ size: "sm" })}>
              Apply
            </button>
          </div>
          {query.qTruncated && (
            <p className="doc-p text-brand-lift">The search was cut at 80 characters.</p>
          )}
        </form>

        {/* 2026-08-23 UX: .sec-head の既定は 4rem。
            フィルタと、そのフィルタが操作する表とが無関係な2つの節に見えていた。
            ここだけ 24px（mt-6）へ寄せて1つのまとまりにする。 */}
        {/* 2026-09-02 UI/UX 監査（続）: 「文字だらけで直感的でない」。件数チップを
            判定の積み上げバー（Figure 1）にする。数字はそのまま、形が加わるだけ。
            凡例がチップを兼ね、クリックで絞る。 */}
        {(() => {
          const filtered = Boolean(query.q || query.verdict || query.network || query.l1);
          const hrefs = {
            pass: observatoryHref({ ...query, verdict: query.verdict === "pass" ? null : "pass" }, 1),
            fail: observatoryHref({ ...query, verdict: query.verdict === "fail" ? null : "fail" }, 1),
            unverified: observatoryHref({ ...query, verdict: query.verdict === "unverified" ? null : "unverified" }, 1),
            withdrawn: observatoryHref({ ...query, verdict: query.verdict === "withdrawn" ? null : "withdrawn" }, 1),
          };
          if (filtered) {
            const band = l0BandFromVerdictCounts(overview.verdictCounts, query.verdict);
            const settledEndpoints = overview.verdictCounts.settledEndpoints;
            const rateFilters = observatoryRateFilters(query);
            return (
              <VerdictShareBar
                n={1}
                counts={band.counts}
                hrefs={hrefs}
                active={query.verdict ?? null}
                legendExtra={
                  settledEndpoints > 0 ? (
                    <a
                      href={observatoryHref({ ...query, l1: !query.l1 }, 1)}
                      aria-current={query.l1 ? "true" : undefined}
                      className={`inline-flex min-h-11 items-center whitespace-nowrap tabular-nums underline decoration-1 hover:decoration-2 ${query.l1 ? "text-brand-deep decoration-2" : "text-brand hover:text-brand-deep"}`}
                    >
                      [settled on-chain {settledEndpoints.toLocaleString()}]
                    </a>
                  ) : null
                }
                caption={
                  <>
                    The pass rate above is the L0 probe of the rows in this filter. It is not the purchase result.
                    Choosing a verdict does not change that rate. This rate covers {band.total.toLocaleString()} endpoints.
                    {rateFilters ? <> {rateFilters}</> : null}
                    {query.network ? (
                      <>
                        {" "}
                        Network accepts a chain name or a network id. Solana, solana, and
                        solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp are the same chain. The L1 cell counts purchases on
                        the chain named in the filter.
                      </>
                    ) : null}
                  </>
                }
              />
            );
          }
          if (!stats) return null;
          const band = l0BandFromStats(stats);
          return (
          <VerdictShareBar
            n={1}
            counts={band.counts}
            hrefs={hrefs}
            active={query.verdict ?? null}
            legendExtra={
              stats.l1.endpointsSettled > 0 ? (
                <a
                  href={observatoryHref({ ...query, l1: !query.l1 }, 1)}
                  aria-current={query.l1 ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center whitespace-nowrap tabular-nums underline decoration-1 hover:decoration-2 ${query.l1 ? "text-brand-deep decoration-2" : "text-brand hover:text-brand-deep"}`}
                >
                  [settled on-chain {stats.l1.endpointsSettled.toLocaleString()}]
                </a>
              ) : null
            }
            caption={
              <>
                Published L0 verdict, {band.total.toLocaleString()} endpoints on record (includes
                delisted; {stats.activeEndpoints.toLocaleString()} active; {stats.publishedPassActive.toLocaleString()}{" "}
                of the passes are currently listed). Settled on-chain counts endpoints with at least one purchase
                vet402 re-read on-chain, listed or not: {stats.l1.endpointsSettledSellerReceipt.toLocaleString()} with a transaction the
                seller named in its own settlement receipt and {stats.l1.endpointsSettledIndexOnly.toLocaleString()}{" "}
                where the seller returned no receipt and vet402&apos;s own settlements index found the settled
                transfers, as reported by <code>/api/v1/observatory/state</code>.{" "}
                {withdrawnBandCountSentence(band.counts.withdrawn)} Select a
                legend entry to filter the table.
              </>
            }
          />
          );
        })()}

        <h2 className="sec-head mt-6">
          <span className="sec-no">1.</span>
          <span>Observed endpoints</span>
        </h2>
        {overview.rows.length === 0 ? (
          <p className="doc-p text-brand-lift">
            {query.q || query.verdict || query.network || query.l1 ? (
              <>
                No endpoints match those filters.{" "}
                <Link href="/observatory" className="underline">
                  Clear filters
                </Link>
                .
              </>
            ) : (
              "No observations yet. The first catalog ingest populates this table; measurements accumulate daily after that."
            )}
          </p>
        ) : (
          <TableScroll label="L0 observations over catalog endpoints" className="mt-3">
            <table className="fact-table">
              <caption className="sr-only">L0 observations over catalog endpoints</caption>
              <thead>
                {/* 2026-09-02 UX 監査: 375px で L0 判定列が横 1,110px 先（3.6 画面右）だった。
                    判定を 2 列目に、Endpoint はモバイルで 13rem に切り詰めて（title に全文）、
                    初期表示に Endpoint + L0 が必ず入るようにする。 */}
                {/* 2026-09-02 導線監査 F2: L1 列（settled/attempts）を L0 の右に。7→8 列になるので
                    モバイルの Endpoint は 11rem に詰め、Endpoint + L0 + L1 が初期表示に入るようにする。 */}
                <tr>
                  <th scope="col">Endpoint</th>
                  <th scope="col">L0</th>
                  {/* 2026-09-29 監査 5 周目: 見出しが「settled / delivered」、セルが「delivered · settled/attempts」で
                      順が逆だった。セルと同じ順・同じ語にし、見出しの短い語の意味は読み上げにも渡す。 */}
                  <th scope="col" className="num">
                    {/* th は nowrap。2 行に割って列幅を旧見出し（22 字）より広げない。 */}
                    L1 delivered ·<br /> settled / attempts
                    <span className="sr-only">
                      {" "}
                      (delivered: a settled purchase whose paid request answered 2xx; settled: the transfer re-read
                      on-chain; attempts: paid attempts)
                    </span>
                  </th>
                  <th scope="col">Last probed</th>
                  <th scope="col">Network</th>
                  <th scope="col">Declared method</th>
                  <th scope="col">Catalog</th>
                  <th scope="col" className="num">
                    Calls 30d
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap">
                      <Link
                        href={`/observatory/e/${row.id}`}
                        className="flex min-h-11 min-w-0 max-w-[11rem] items-center truncate underline decoration-1 hover:decoration-2 sm:max-w-[24rem]"
                        title={row.resourceKey}
                      >
                        {row.resourceKey}
                      </Link>
                    </td>
                    <td>
                      {row.publishedVerdict === "withdrawn" ? (
                        <span className="text-brand-lift">withdrawn</span>
                      ) : (
                        <VerdictWord verdict={row.publishedVerdict} />
                      )}
                    </td>
                    {/* 2026-09-04 外部監査 E・P0-3: settled だけを出していた。settled は
                        転送の確認、delivered は応答の到着。同じ数のときも省略しない
                        （同じときだけ隠すのが、10/10 settled・2xx 0 件を見逃した形）。 */}
                    <td className="num whitespace-nowrap">
                      {/* 2026-09-04 監査 E: delivered（品が来た）と settled（受領証あり）は別の数。
                          reader が l1Delivered を返すようになったら `delivered · settled/attempts`。 */}
                      <L1Ratio settled={row.l1Settled} attempts={row.l1Attempts} delivered={row.l1Delivered} />
                    </td>
                    <td className="whitespace-nowrap">{fmtDate(row.lastProbedAt)}</td>
                    {/* カタログの鎖が絞り込みの外なら、セルは絞り込みの公開名。カタログの id は title。 */}
                    <td className="whitespace-nowrap" title={networkFilterCellTitle(row.network, query.network)}>
                      {networkFilterCellLabel(row.network, query.network)}
                    </td>
                    <td>{row.method ?? "undeclared"}</td>
                    <td>{row.status}</td>
                    <td className="num">
                      {row.qualityCalls30d === null ? "—" : row.qualityCalls30d.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <nav aria-label="Observatory pages" className="doc-p flex flex-wrap items-center gap-x-4 gap-y-2">
          {page > 1 && (
            <Link href={observatoryHref(query, page - 1)} className="inline-flex min-h-11 items-center underline decoration-1 hover:decoration-2">
              ← Previous
            </Link>
          )}
          <span>
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link href={observatoryHref(query, page + 1)} className="inline-flex min-h-11 items-center underline decoration-1 hover:decoration-2">
              Next →
            </Link>
          )}
        </nav>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Reading this table</span>
        </h2>
        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            {/* 2026-08-23 UX: 約120語・リンク7本を1段落に詰めており、初見の読者が
                表へ到達するまでが遠かった。残したのは (a) 何を測っているか
                (b) pass/fail/unverified は意見ではない (c) L1 は別ページ、の3点。
                落としたのは「No account」「キーはスコアAPI専用」「headline numbers」
                といった、表を読む前には要らない但し書き——消したのではなく、
                すぐ下の §1 と既存のリンク群が同じことを言っている。 */}
            Every endpoint in the public x402 discovery catalog: is it still listed, and does its
            payment wall answer a valid <code>402</code> challenge. The probe uses the HTTP method
            the listing declares when that method is GET, POST, HEAD, or DELETE, and GET when the
            listing declares no method or a method outside that set. Two failures in a row on that
            probe can be published as fail. The catalog is re-fetched daily. Endpoints are probed on a rolling
            schedule. A probed row shows the probe time under Last probed, after the L1 column. A
            row that has not been probed shows no probe time. The L0 cell is the payment-wall
            measurement alone. The L1 cell counts real purchases whose transfer vet402 re-read
            on-chain (settled / paid attempts). The transaction named by the seller&apos;s receipt, or found by vet402&apos;s own index when the seller returned none, is what that count places above the count that
            also returned a 2xx response (delivered), with every transaction listed on the
            endpoint&apos;s page. The
            two are never mixed.{" "}
            <strong>pass / fail / unverified / withdrawn</strong> are defined measurements, not opinions.
            A withdrawn row is absent from a complete catalog fetch and its newest probes would publish as fail.
            It is left out of the public L0 fail count.{" "}
            <Link href="/observatory/methodology" className="underline">
              Definitions are here
            </Link>
            . unverified means vet402 does not have grounds to publish either pass or fail yet. It is not a failure and is never counted as one: it is an entry not yet reached by the rolling schedule, an entry whose failing probe has not met the publication gate, an entry recorded as path_template, or the remainder after the three above. The remainder includes a latest reason of rate_limited, tls, request_shape, or unsafe_target. It also includes a latest reason of method_undeclared, for which no request was sent before 2026-09-02, and body_over_cap, for which a 402 came back and the body was not read to the end. A listing that declares no HTTP method, or a method other than GET, POST, HEAD, or DELETE, is measured with GET, and two consecutive failures of that probe can be published as fail. The current
            breakdown is counted out in{" "}
            <Link href="/observatory/methodology" className="underline">
              the methodology
            </Link>
            .
          </p>
        </div>

        <p className="doc-p">
          <strong>Order.</strong> Endpoints with at least one settled L1 purchase first, then measured
          endpoints (pass / fail), then by observed call volume (catalog-reported, last 30 days).{" "}
          <strong>L1</strong> is shown as <code>delivered · settled / attempts</code> for that endpoint;{" "}
          <code>—</code> means no purchase was attempted. <strong>settled</strong> is the transfer vet402
          re-read on-chain; <strong>delivered</strong> is a settled attempt whose paid request also
          answered <code>2xx</code>. A paid attempt that answered <code>4xx</code> — settled, or
          refused with no settlement receipt — is published as <code>inconclusive</code> and is not
          counted against the seller: vet402 buys with no API key of the seller&apos;s and sends a
          POST body only when the seller declares one, so a <code>4xx</code> can be vet402&apos;s own
          request being malformed. So is a <code>402</code> or <code>5xx</code> from 2026-09-13 00:00 to 2026-09-15 23:49
          UTC, when vet402&apos;s own payer wallet had run out of USDC. The endpoint&apos;s page shows
          those rows and the count (
          <Link href="/observatory/methodology" className="underline">
            methodology §2
          </Link>
          ). Per-endpoint counts use the
          same paid-attempt denominator as the totals reported by <code>/api/v1/observatory/state</code>.
          The <em>[settled on-chain]</em> entry under Figure 1 lists the endpoints with at least one purchase settled
          on-chain, whether the transaction came from the seller&apos;s receipt or from vet402&apos;s own index. A{" "}
          <em>receipt</em> on these pages is the seller&apos;s own settlement receipt.
        </p>
        <p className="doc-p">
          <strong>Snapshot line.</strong> <em>fetched</em> is the number of raw catalog items received across
          pages, counted before duplicate URLs collapse into one endpoint key; <em>catalog</em> is the total
          the catalog reports about itself. Fetched can exceed the catalog total for that reason, and a fetch
          below the total is incomplete: no delisting judgement is made on such a day. Endpoints on record
          (Figure 1) include delisted entries; the Catalog column says which are still listed. The{" "}
          <em>active</em> count under Figure 1 is a different figure from the catalog total on the snapshot
          line: it counts endpoint rows on record whose catalog status is still <code>active</code>. That
          status is set when a fetch lists the endpoint and flipped to <code>delisted</code> only by the
          daily diff against the previous day&apos;s snapshot on a complete fetch, so it is carried over from
          earlier days rather than re-read from the snapshot line, and the two need not agree.
        </p>
        <p className="doc-p">
          <strong>Catalog</strong> is presence in the public discovery catalog: <code>active</code>{" "}
          means listed as of the latest snapshot; <code>delisted</code> means the entry was present
          on an earlier day and absent on a complete fetch — with the before/after recorded on the
          endpoint&apos;s page. <strong>L0</strong> is the payment-wall measurement.{" "}
          <code>pass</code> means a probe received HTTP 402 with a parseable{" "}
          <code>accepts</code> array consistent with the catalog declaration. The probe uses the HTTP method the listing declares when that method is GET, POST, HEAD, or DELETE, and GET when the listing declares no method or a method outside that set.{" "}
          <code>fail</code> means two or more consecutive probes contradicted the catalog declaration (each with a recorded reason).{" "}
          <code>unverified</code>. unverified means vet402 does not have grounds to publish either pass or fail yet. It is not a failure and is never counted as one: it is an entry not yet reached by the rolling schedule, an entry whose failing probe has not met the publication gate, an entry recorded as path_template, or the remainder after the three above. The remainder includes a latest reason of rate_limited, tls, request_shape, or unsafe_target. It also includes a latest reason of method_undeclared, for which no request was sent before 2026-09-02, and body_over_cap, for which a 402 came back and the body was not read to the end. A listing that declares no HTTP method, or a method other than GET, POST, HEAD, or DELETE, is measured with GET, and two consecutive failures of that probe can be published as fail. A day on which vet402&apos;s own fetch was incomplete produces no delisting
          judgements at all.
        </p>
        <p className="doc-p">
          <Link href="/payee" className="underline">
            Verify a payee
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">
            ·
          </span>
          <Link href="/signup" className="underline">
            Get an API key
          </Link>
        </p>
      </article>
    </main>
  );
}
