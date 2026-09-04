import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd, datasetJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { TableScroll } from "@/components/site/TableScroll";
import {
  getObservatoryStatsByChainCached,
  getObservatoryStatsCached,
  getCoverageShareCached,
} from "@/lib/observatory/cached-reads";
import { getDailyMetricsHistory, type DailyMetricsRow } from "@/lib/observatory/metrics-rollup";
import { getAnchors } from "@/lib/observatory/anchors";

/**
 * /observatory/state — the State of x402 headline numbers (design §7).
 *
 * The ecosystem's dead-endpoint and silent-delisting problem has so far been
 * reported only as single-operator anecdotes. These are the same phenomena
 * quantified over the full public catalog — every figure carries its
 * denominator and the fetch-health caveat, and unverified is reported as its
 * own bucket, never folded into fail.
 */

export const metadata: Metadata = pageMetadata({
  title: "State of x402",
  description:
    "Headline measurements over the full public x402 catalog: how many endpoints answer a valid 402 challenge, how many were delisted, and how much of the catalog is machine-verifiable at all.",
  path: "/observatory/state",
});

export const revalidate = 600;

function pct(n: number, denom: number): string {
  if (denom === 0) return "—";
  return `${((n / denom) * 100).toFixed(1)}%`;
}

/**
 * 履歴チャート（Phase 1.1）。サーバー側で組む素のSVG折れ線2本
 * （日次L0 probes / うちpass・全チェーン合算）。外部チャート依存を
 * 入れないのは紙面様式と自己完結（CSP・自己ホスト）のため。色は
 * currentColor 継承で、既存のテキスト色クラスに追従する。
 */
function HistoryChart({ rows }: { rows: DailyMetricsRow[] }) {
  const byDay = new Map<string, { probes: number; pass: number }>();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { probes: 0, pass: 0 };
    d.probes += r.l0Probes;
    d.pass += r.l0Pass;
    byDay.set(r.day, d);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const W = 640;
  const H = 180;
  const PAD = { top: 10, right: 8, bottom: 24, left: 44 };
  const max = Math.max(1, ...days.map(([, d]) => d.probes));
  const x = (i: number) =>
    PAD.left + (days.length === 1 ? 0 : (i * (W - PAD.left - PAD.right)) / (days.length - 1));
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const path = (pick: (d: { probes: number; pass: number }) => number) =>
    days.map(([, d], i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(" ");
  const first = days[0]?.[0] ?? "";
  const last = days[days.length - 1]?.[0] ?? "";
  const latest = days[days.length - 1]?.[1] ?? { probes: 0, pass: 0 };

  return (
    <figure className="mt-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Daily L0 probes and passes, ${first} to ${last}. Latest day: ${latest.probes} probes, ${latest.pass} pass.`}
        className="w-full max-w-[640px] text-brand-deep"
      >
        <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} stroke="currentColor" strokeWidth="1" opacity="0.5" />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={y(0)} stroke="currentColor" strokeWidth="1" opacity="0.5" />
        <text x={PAD.left - 6} y={y(max) + 4} textAnchor="end" fontSize="11" fill="currentColor">
          {max.toLocaleString()}
        </text>
        <text x={PAD.left - 6} y={y(0) + 4} textAnchor="end" fontSize="11" fill="currentColor">
          0
        </text>
        <text x={PAD.left} y={H - 6} fontSize="11" fill="currentColor">
          {first}
        </text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize="11" fill="currentColor">
          {last}
        </text>
        <path d={path((d) => d.probes)} fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d={path((d) => d.pass)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.75" />
      </svg>
      <figcaption className="doc-caption mt-1">
        solid: probes · dashed: pass — per UTC day, all chains
      </figcaption>
    </figure>
  );
}

export default async function ObservatoryStatePage() {
  const stats = await getObservatoryStatsCached();
  const chainStats = await getObservatoryStatsByChainCached();
  const history = await getDailyMetricsHistory(60);
  const coverage = await getCoverageShareCached();
  const [latestAnchor] = await getAnchors(1);
  const denom = stats.totalEndpoints;
  const snap = stats.latestSnapshot;
  const fetchComplete = snap ? snap.fetchedCount >= snap.totalCount : false;
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  const dataset = datasetJsonLd({
    name: "State of x402",
    // 引用文の名前は llms.txt と方法論 §9 が既に配っている "observatory" に合わせる。
    citeName: "observatory",
    description:
      "Aggregate L0 liveness and L1 settle-through measurements over the full public x402 discovery catalog, broken out by chain.",
    path: "/observatory/state",
    citeUrl: `${SITE_URL}/api/v1/observatory/state`,
    temporalCoverage: snap?.snapshotDate ?? undefined,
    dateModified: snap?.snapshotDate ?? undefined,
    measurementTechnique:
      "L0: one unpaid HTTP probe per catalog-listed endpoint, using the method the catalog entry declares, checking for HTTP 402 and whether the advertised price, asset, network and payee agree with the catalog; fail is published only after consecutive failing probes. L1: a covert real-money USDC purchase, with the settlement transaction re-read on-chain before it is called settled.",
    variableMeasured: [
      "endpoints on record",
      "currently listed in catalog",
      "delisted endpoints",
      "L0 published pass",
      "L0 published fail",
      "L0 unverified",
      "L1 paid purchase attempts",
      "L1 settled with on-chain receipt",
      "L1 delivered (settled and a 2xx response)",
    ],
    keywords: ["x402", "agent payments", "HTTP 402", "endpoint liveness", "settlement", "USDC"],
    distribution: [
      {
        name: "Aggregate snapshot (JSON)",
        encodingFormat: "application/json",
        contentUrl: `${SITE_URL}/api/v1/observatory/state`,
      },
      {
        name: "Daily series per chain (JSON)",
        encodingFormat: "application/json",
        contentUrl: `${SITE_URL}/api/v1/observatory/history`,
      },
      {
        name: "L1 purchase ledger, one row per paid attempt (CSV)",
        encodingFormat: "text/csv",
        contentUrl: `${SITE_URL}/api/v1/observatory/export.csv?days=90`,
      },
    ],
  });

  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Observatory", path: "/observatory" },
    { name: "State of x402", path: "/observatory/state" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(dataset) }}
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
            <span>Report: State of x402 (L0 aggregate)</span>
            <span>
              {snap ? (
                <>
                  Data as of <span className="text-signal">{snap.snapshotDate}</span>
                  {fetchComplete ? "" : " (incomplete fetch — figures provisional)"}
                </>
              ) : (
                "No catalog snapshot yet"
              )}
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory" className="underline">
                Full register
              </Link>
            </span>
            <span>
              <Link href="/observatory/methodology" className="underline">
                Methodology
              </Link>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-10">State of x402</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            Reports of dead endpoints and silent catalog delisting in the x402 ecosystem have so
            far been anecdotes from individual operators. The figures below are the same
            phenomena measured across the <strong>entire public discovery catalog</strong>, with
            denominators attached. <em>unverified</em> is its own bucket — an entry that cannot
            be machine-checked is not counted as dead.
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Headline measurements</span>
        </h2>
        <TableScroll label="State of x402 headline measurements">
          <table className="fact-table">
            <caption className="sr-only">State of x402 headline measurements</caption>
            <thead>
              <tr>
                <th scope="col">Measurement</th>
                <th scope="col" className="num">
                  Count
                </th>
                <th scope="col" className="num">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-brand">Endpoints on record (denominator)</td>
                <td className="num">{denom.toLocaleString()}</td>
                <td className="num">—</td>
              </tr>
              <tr>
                <td className="text-brand">Currently listed in the catalog</td>
                <td className="num">{stats.activeEndpoints.toLocaleString()}</td>
                <td className="num">{pct(stats.activeEndpoints, denom)}</td>
              </tr>
              <tr>
                <td className="text-brand">Delisted (absent on a complete fetch)</td>
                <td className="num">{stats.delistedEndpoints.toLocaleString()}</td>
                <td className="num">{pct(stats.delistedEndpoints, denom)}</td>
              </tr>
              <tr>
                <td className="text-brand">
                  Payment wall answers a valid 402 (published pass)
                </td>
                <td className="num">{stats.publishedPass.toLocaleString()}</td>
                <td className="num">{pct(stats.publishedPass, denom)}</td>
              </tr>
              <tr>
                <td className="text-brand">
                  Payment wall failing on ≥2 consecutive probes (published fail)
                </td>
                <td className="num">{stats.publishedFail.toLocaleString()}</td>
                <td className="num">{pct(stats.publishedFail, denom)}</td>
              </tr>
              <tr>
                <td className="text-brand">Unverified (gate unmet, or not yet probed)</td>
                <td className="num">{stats.publishedUnverified.toLocaleString()}</td>
                <td className="num">{pct(stats.publishedUnverified, denom)}</td>
              </tr>
              <tr>
                <td className="text-brand">
                  Catalog entries declaring no HTTP method (not machine-checkable)
                </td>
                <td className="num">{stats.methodUndeclared.toLocaleString()}</td>
                <td className="num">{pct(stats.methodUndeclared, denom)}</td>
              </tr>
            </tbody>
          </table>
        </TableScroll>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>By chain</span>
        </h2>
        <p className="doc-p">
          L0 observation has always been chain-agnostic and costs nothing to run, so this table
          covers every chain the public catalog lists an endpoint on — not only the chain L1
          purchasing currently targets (Base and Solana). Mainnets only; testnet listings (Base
          Sepolia, Solana devnet) are excluded below.
        </p>
        {chainStats.length === 0 ? (
          <p className="doc-p text-brand-lift">No chain data yet.</p>
        ) : (
          <TableScroll label="State of x402 by chain">
            {/* 2026-09-02 デザイン監査 P1: 390px で数値列が 1 つも見えなかった。先頭列は
                TableScroll が sticky にする。ここでは列間を 0.75rem に詰め、見出しを
                短くして、Chain + Endpoints + Listed が 358px の紙面に入るようにする。 */}
            <table className="fact-table [&_td]:pr-3 [&_th]:pr-3">
              <caption className="sr-only">State of x402 by chain</caption>
              <thead>
                <tr>
                  <th scope="col">Chain</th>
                  <th scope="col" className="num">
                    <abbr title="Endpoints on record" className="no-underline">n</abbr>
                  </th>
                  <th scope="col" className="num">
                    Listed
                  </th>
                  <th scope="col" className="num">
                    Pass
                  </th>
                  <th scope="col" className="num">
                    Fail
                  </th>
                  <th scope="col" className="num">
                    Unverified
                  </th>
                </tr>
              </thead>
              <tbody>
                {chainStats.map((c) => (
                  <tr key={c.chain}>
                    {/* 生の CAIP-2 id（solana:EtWT… 44 字）が 600px の列を作っていた。390px では 9rem で切る（title に全文）。 */}
                    <td className="text-brand">
                      <span className="block max-w-[9rem] truncate sm:max-w-none" title={c.chain}>
                        {c.chain}
                      </span>
                    </td>
                    <td className="num">{c.totalEndpoints.toLocaleString()}</td>
                    <td className="num">{pct(c.activeEndpoints, c.totalEndpoints)}</td>
                    <td className="num">{pct(c.publishedPass, c.totalEndpoints)}</td>
                    <td className="num">{pct(c.publishedFail, c.totalEndpoints)}</td>
                    <td className="num">{pct(c.publishedUnverified, c.totalEndpoints)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>L1 — real purchases (covert)</span>
        </h2>
        {stats.l1.attempts === 0 ? (
          <p className="doc-p text-brand-lift">
            No purchases attempted yet. When active, this section reports settlement penetration
            over real paid requests, each backed by an on-chain receipt, alongside how many of
            those settled attempts also returned the thing being sold.
          </p>
        ) : (
          <TableScroll label="L1 covert-purchase measurements">
            <table className="fact-table">
              <caption className="sr-only">L1 covert-purchase measurements</caption>
              <thead>
                {/* 2026-09-04 外部監査 E・P1-13: "Share" 1 列に、attempts を分母にする行と
                    endpoints を分母にする行が混ざっていた。同じ見出しの下に別の分母を置くと
                    読者は 2 つの率を比べてしまう。分母を列見出しに書く。 */}
                <tr>
                  <th scope="col">Measurement</th>
                  <th scope="col" className="num">
                    Count
                  </th>
                  <th scope="col" className="num">
                    Share of its own denominator
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* 2026-09-04 監査 E: Share 列は上 2 行が attempts 分母、下 2 行が endpoints 分母で、
                    同じ列見出しの下に 2 つの分母が黙って混ざっていた。行ラベルに分母を書く。 */}
                <tr>
                  <td className="text-brand">Paid purchase attempts (money signed and sent): the denominator of the next row</td>
                  <td className="num">{stats.l1.attempts.toLocaleString()}</td>
                  <td className="num">— (denominator)</td>
                </tr>
                <tr>
                  <td className="text-brand">Settled: transfer confirmed on-chain</td>
                  <td className="num">{stats.l1.settled.toLocaleString()}</td>
                  <td className="num">{pct(stats.l1.settled, stats.l1.attempts)} of attempts</td>
                </tr>
                {/* 2026-09-04 外部監査 E・P0-3: settled と delivered は別の事実。
                    本番実測では settled のうち 120 件が非 2xx だった。 */}
                <tr>
                  <td className="text-brand">
                    Delivered: settled and the paid request answered <code>2xx</code>
                  </td>
                  <td className="num">{stats.l1.delivered.toLocaleString()}</td>
                  <td className="num">{pct(stats.l1.delivered, stats.l1.attempts)} of attempts</td>
                </tr>
                <tr>
                  <td className="text-brand">Settled but the paid request answered 4xx or 5xx</td>
                  <td className="num">{Math.max(0, stats.l1.settled - stats.l1.delivered).toLocaleString()}</td>
                  <td className="num">
                    {pct(Math.max(0, stats.l1.settled - stats.l1.delivered), stats.l1.attempts)} of attempts
                  </td>
                </tr>
                <tr>
                  <td className="text-brand">Distinct endpoints purchased from: the denominator of the next row</td>
                  <td className="num">{stats.l1.endpointsAttempted.toLocaleString()}</td>
                  <td className="num">— (denominator)</td>
                </tr>
                <tr>
                  <td className="text-brand">Endpoints with at least one settled receipt (share of endpoints purchased from)</td>
                  <td className="num">{stats.l1.endpointsSettled.toLocaleString()}</td>
                  <td className="num">
                    {pct(stats.l1.endpointsSettled, stats.l1.endpointsAttempted)} of endpoints purchased from
                  </td>
                </tr>
                <tr>
                  <td className="text-brand">Endpoints with at least one delivered response</td>
                  <td className="num">{stats.l1.endpointsDelivered.toLocaleString()}</td>
                  <td className="num">
                    {pct(stats.l1.endpointsDelivered, stats.l1.endpointsAttempted)} of endpoints purchased from
                  </td>
                </tr>
              </tbody>
            </table>
          </TableScroll>
        )}
        <p className="doc-p">
          Attempt and settled counts above are as reported by <code>/api/v1/observatory/state</code>{" "}
          (<code>l1.attempts</code>, <code>l1.settled</code>): an attempt is a paid request whose payment was
          signed and sent, whatever the seller answered. The per-endpoint cells on the{" "}
          <Link href="/observatory" className="underline">
            register
          </Link>{" "}
          use the same denominator. Other machine-readable surfaces (<code>decisions</code>,{" "}
          <code>history</code>, <code>export.csv</code>) apply their own definition of an attempt and can
          differ; when a number is quoted from this site, the state API is the one to cite.
        </p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Listing-change events observed</span>
        </h2>
        <TableScroll label="Catalog listing-change events observed to date">
          <table className="fact-table">
            <caption className="sr-only">Catalog listing-change events observed to date</caption>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col" className="num">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-brand">delisted — vanished from a complete fetch</td>
                <td className="num">{stats.eventCounts.delisted.toLocaleString()}</td>
              </tr>
              <tr>
                <td className="text-brand">relisted — returned after a delisting</td>
                <td className="num">{stats.eventCounts.relisted.toLocaleString()}</td>
              </tr>
              <tr>
                <td className="text-brand">
                  settle_drop — catalog-reported 30-day calls fell ≥70% from a ≥100 base
                </td>
                <td className="num">{stats.eventCounts.settleDrop.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </TableScroll>

        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>Coverage and ledger integrity</span>
        </h2>
        <p className="doc-p">
          <strong>Coverage (7-day window):</strong>{" "}
          {coverage.pct === null
            ? "no active endpoints on record"
            : `${coverage.measuredLast7d.toLocaleString()} of ${coverage.activeEndpoints.toLocaleString()} active listed endpoints (${coverage.pct}% of active listed endpoints) carry an L0 measurement from the last 7 days`}
          . This is the machine definition behind &quot;endpoints under regular
          verification&quot; — numerator and denominator as stated, nothing else.
        </p>
        <p className="doc-p">
          <strong>Ledger integrity:</strong>{" "}
          {latestAnchor ? (
            <>
              daily hash chain over the full purchase ledger, latest root ({latestAnchor.day}):{" "}
              <code>{latestAnchor.rootHash.slice(0, 16)}…</code> over that day&apos;s{" "}
              {latestAnchor.entryCount.toLocaleString()} ledger entries (an anchor counts the rows it hashed, not
              the L1 attempts above). Rewriting any past row breaks
              every later root. Recompute it yourself:{" "}
              <code>/api/v1/observatory/anchors</code> + <code>/api/v1/observatory/export.csv</code>{" "}
              (projection is open source).
            </>
          ) : (
            <>
              daily hash chain starts with the first anchored day —{" "}
              <code>/api/v1/observatory/anchors</code>.
            </>
          )}
        </p>

        <h2 className="sec-head">
          <span className="sec-no">6.</span>
          <span>Daily history</span>
        </h2>
        {history.length === 0 ? (
          <p className="doc-p">
            No rolled-up days yet — the daily rollup starts filling this section from its first
            run. The machine-readable series will appear at{" "}
            <code>/api/v1/observatory/history</code>.
          </p>
        ) : (
          <>
            <p className="doc-p">
              L0 probes per UTC day (upper line) and how many of them measured{" "}
              <em>pass</em> (lower line), all chains combined, last {history.length} days.
              Machine-readable, per-chain: <code>/api/v1/observatory/history</code>.
            </p>
            <HistoryChart rows={history} />
          </>
        )}

        <h2 className="sec-head">
          <span className="sec-no">7.</span>
          <span>Caveats</span>
        </h2>
        <p className="doc-p">
          Figures are computed from days whose catalog fetch was complete; incomplete days
          withhold delisting judgements entirely. Probes cycle through the catalog on a rolling
          schedule, so <em>unverified</em> includes endpoints simply not yet reached. vet402&apos;s
          own listings, when present, pass through the identical pipeline (
          <Link href="/observatory/methodology" className="underline">
            fairness commitments
          </Link>
          ). None of these figures is an assessment of any individual operator.
        </p>
      </article>
    </main>
  );
}
