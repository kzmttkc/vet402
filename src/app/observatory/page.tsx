import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { TableScroll } from "@/components/site/TableScroll";
import { buttonClass } from "@/components/ui/Button";
import { getObservatoryOverview, getObservatoryStats } from "@/lib/observatory/reader";
import { parseObservatorySearchParams, observatoryHref } from "@/lib/observatory/query";
import { chainLabel } from "@/lib/observatory/chains";
import TrackView from "@/components/site/TrackView";
import { VerdictShareBar, VerdictWord } from "@/components/site/Figures";

/**
 * /observatory — the L0 fact table over the x402 catalog (design §5).
 *
 * What this page is NOT: a ranking, a score, or an opinion. Every cell is a
 * measurement with a definition (see /observatory/methodology): the catalog
 * said X, the payment wall answered Y. The verdict vocabulary is closed —
 * pass / fail / unverified — and a fail only appears after the publication
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
  title: "x402 Observatory",
  description:
    "Daily measurements over the public x402 catalog: does each endpoint's payment wall answer a valid 402 challenge, and is it still listed. Facts with timestamps, no scores.",
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
  const overview = await getObservatoryOverview(query);
  // 2026-09-02 UX 監査: 既定表示の上位 20 行が全部 unverified（登録の 84%）で、初見の人が
  // 「測れていない製品」と読んだ。判定ごとの件数を表の直上に出し、1 クリックで絞れるようにする。
  const stats = await getObservatoryStats().catch(() => null);
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
      <article className="sheet">
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

        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Register: x402 endpoints, L0 · L1</span>
            <span>
              {overview.latestSnapshot ? (
                <>
                  {/* 1 行に収める（"Catalog snapshot: … (N of N fetched)" は 2 行に折れていた）。数字はそのまま。 */}
                  {/* 2026-09-04 外部監査 E・P1-13: 裸の N/N は何の分母か読めなかった。
                      左は我々が取得できた件数、右はカタログが自己申告する総数。 */}
                  Snapshot{" "}
                  <span className="text-signal">{overview.latestSnapshot.snapshotDate}</span>{" "}
                  ·{" "}
                  <span
                    title={`${overview.latestSnapshot.fetchedCount.toLocaleString()} entries fetched by vet402 out of the ${overview.latestSnapshot.totalCount.toLocaleString()} the catalog reported for that day`}
                  >
                    {overview.latestSnapshot.fetchedCount.toLocaleString()} fetched /
                    {" "}
                    {overview.latestSnapshot.totalCount.toLocaleString()} reported
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
            <span>Table: L0 and L1 receipts</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">The x402 Observatory</h1>
        {/* 2026-08-23 UX: 表が何であるかを、Abstract を読む前に1行で言う。
            RFC の版面を壊さないよう新しい枠は足さず、表題直下の弱いインクの
            1行として置く。 */}
        <p className="mt-2 text-brand-lift">
          This page lists live endpoint checks. Values here are measurements, not opinions.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        {/* 2026-09-02 デザイン監査 P1: 1280×800 で最初の画面に操作対象が無かった（検索 y=831・
            図 y=1046・表 y=1177、Abstract 11 行が y=766–1140）。rule-double の直下を
            検索 → Figure 1 → §1 表にし、Abstract は §2「Reading this table」の冒頭へ移す（文は同じ）。 */}
        <form method="get" action="/observatory" className="mt-5">
          <p className="doc-caption">Find an endpoint</p>
          {query.l1 && <input type="hidden" name="l1" value="1" />}
          {/* 390px: 4 段積み（266px）だと Figure 1 が最初の画面に入らない。Contains を 1 行、
              L0 / Network / Apply を 2 行目に並べる。 */}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block min-w-0 basis-full text-[0.8125rem] sm:basis-auto sm:flex-1">
              <span className="doc-caption block">Contains</span>
              <input
                name="q"
                type="search"
                defaultValue={query.q ?? ""}
                className="doc-input mt-1"
              />
            </label>
            <label className="block text-[0.8125rem]">
              <span className="doc-caption block">L0</span>
              <select
                name="verdict"
                defaultValue={query.verdict ?? ""}
                className="doc-input mt-1"
              >
                <option value="">any</option>
                <option value="pass">pass</option>
                <option value="fail">fail</option>
                <option value="unverified">unverified</option>
              </select>
            </label>
            <label className="block min-w-0 flex-1 text-[0.8125rem] sm:min-w-[16ch] sm:flex-none">
              <span className="doc-caption block">Network</span>
              <input
                name="network"
                defaultValue={query.network ?? ""}
                placeholder="eip155:8453"
                className="doc-input mt-1"
              />
            </label>
            {/* 2026-08-23 UX: underline のテキストリンクに見えており、フィルタを
                確定する主操作だと分からなかった。既存の buttonClass（紙面の
                ボタン表現）へ寄せる——新しい色も角丸も足していない。 */}
            <button type="submit" className={buttonClass({ size: "sm" })}>
              Apply
            </button>
          </div>
        </form>

        {/* 2026-08-23 UX: .sec-head の既定は margin-top 3.5rem（56px）で、
            フィルタと、そのフィルタが操作する表とが無関係な2つの節に見えていた。
            ここだけ 24px へ寄せて1つのまとまりにする。globals.css が
            「Tailwind のユーティリティに負ける必要があるので @layer components」と
            明記しているとおり、局所の上書きが正規の手段。他ページの版面律動は
            触っていない。 */}
        {/* 2026-09-02 UI/UX 監査（続）: 「文字だらけで直感的でない」。件数チップを
            判定の積み上げバー（Figure 1）にする。数字はそのまま、形が加わるだけ。
            凡例がチップを兼ね、クリックで絞る。 */}
        {stats && (
          <VerdictShareBar
            n={1}
            counts={{ pass: stats.publishedPass, fail: stats.publishedFail, unverified: stats.publishedUnverified }}
            hrefs={{
              pass: observatoryHref({ ...query, verdict: query.verdict === "pass" ? null : "pass" }, 1),
              fail: observatoryHref({ ...query, verdict: query.verdict === "fail" ? null : "fail" }, 1),
              unverified: observatoryHref({ ...query, verdict: query.verdict === "unverified" ? null : "unverified" }, 1),
            }}
            active={query.verdict ?? null}
            legendExtra={
              stats.l1.endpointsSettled > 0 ? (
                <a
                  href={observatoryHref({ ...query, l1: !query.l1 }, 1)}
                  aria-current={query.l1 ? "true" : undefined}
                  className={`whitespace-nowrap tabular-nums underline ${query.l1 ? "text-brand-deep decoration-2" : "text-brand hover:text-brand-deep hover:decoration-2"}`}
                >
                  [receipts {stats.l1.endpointsSettled.toLocaleString()}]
                </a>
              ) : null
            }
            caption={
              <>
                Published L0 verdict, {stats.totalEndpoints.toLocaleString()} endpoints on record. Select a legend entry to
                filter the table.
              </>
            }
          />
        )}

        <h2 className="sec-head mt-5">
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
                  <th scope="col" className="num">
                    L1 settled / delivered
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
                        className="block max-w-[11rem] truncate underline sm:max-w-[24rem]"
                        title={row.resourceKey}
                      >
                        {row.resourceKey}
                      </Link>
                    </td>
                    <td>
                      <VerdictWord verdict={row.publishedVerdict} />
                    </td>
                    {/* 2026-09-04 外部監査 E・P0-3: settled だけを出していた。settled は
                        転送の確認、delivered は応答の到着。同じ数のときも省略しない
                        （同じときだけ隠すのが、10/10 settled・2xx 0 件を見逃した形）。 */}
                    <td className="num whitespace-nowrap">
                      {row.l1Attempts === 0 ? (
                        "—"
                      ) : (
                        <>
                          <span className={row.l1Settled > 0 ? "text-brand-deep" : "text-[#9f0712]"}>
                            {row.l1Settled}/{row.l1Attempts}
                          </span>
                          <span className="block text-[0.75rem] text-brand-lift">
                            {row.l1Delivered} delivered
                          </span>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap">{fmtDate(row.lastProbedAt)}</td>
                    {/* 2026-09-02 可用性監査 P2: eip155:8453 と base が混在。chainLabel で同じ鎖は同じ語に。 */}
                    <td className="whitespace-nowrap" title={row.network ?? undefined}>
                      {row.network ? chainLabel(row.network) : "—"}
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
            <Link href={observatoryHref(query, page - 1)} className="underline">
              ← Previous
            </Link>
          )}
          <span>
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link href={observatoryHref(query, page + 1)} className="underline">
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
            payment wall answer a valid <code>402</code> challenge when approached with the method
            it declares. The catalog is re-fetched daily; endpoints are probed on a rolling
            schedule, and each row shows when it was last probed. The L0 cell is the payment-wall
            measurement alone; the L1 cell counts real purchases that returned an on-chain receipt
            (settled / paid attempts) above the count that also returned a 2xx response
            (delivered), with every receipt listed on the endpoint&apos;s page. The
            two are never mixed.{" "}
            <strong>pass / fail / unverified</strong> are defined measurements, not opinions —{" "}
            <Link href="/observatory/methodology" className="underline">
              definitions here
            </Link>
            . <em>unverified is not a failure</em>: it means we do not have grounds to publish
            either of the other two yet. Most often that is because the rolling schedule has not
            reached the endpoint, or a single failing probe has not met the publication gate; the
            entry declaring too little to check is one cause among several, and the current
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
          <strong>L1</strong> is settled / paid attempts for that endpoint, with the delivered count
          beneath it; <code>—</code> means no purchase was attempted. <strong>settled</strong> is the
          transfer vet402 re-read on-chain; <strong>delivered</strong> is a settled attempt whose
          paid request also answered <code>2xx</code>. A settled attempt that answered 4xx or 5xx
          moved money without returning the thing being sold, so it counts once and not twice.
          The <em>[receipts]</em> entry under Figure 1 keeps only rows with a receipt.
        </p>
        <p className="doc-p">
          <strong>Catalog</strong> is presence in the public discovery catalog: <code>active</code>{" "}
          means listed as of the latest snapshot; <code>delisted</code> means the entry was present
          on an earlier day and absent on a complete fetch — with the before/after recorded on the
          endpoint&apos;s page. <strong>L0</strong> is the payment-wall measurement:{" "}
          <code>pass</code> — a probe using the declared method received HTTP 402 with a parseable{" "}
          <code>accepts</code> array consistent with the catalog declaration; <code>fail</code> —
          two or more consecutive probes contradicted that (each with a recorded reason);{" "}
          <code>unverified</code> — not enough declared to measure, or the evidence threshold is
          not yet met. A day on which our own fetch was incomplete produces no delisting
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
