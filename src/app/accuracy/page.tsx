import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { VerdictBadge } from "@/components/site/VerdictBadge";
import { TableScroll } from "@/components/site/TableScroll";
import { computeAccuracyReport, type AccuracyReport } from "@/lib/scoring/accuracy";
import { computeBenchmarkReport, type BenchmarkReport } from "@/lib/scoring/benchmark-report";
import { fetchAccuracyRows, fetchBenchmarkRows } from "@/lib/db/outcome-reader";

/**
 * /accuracy — the page competitors cannot copy without doing the work.
 *
 * 2026-08-05 R&D. The agent-trust field competes on dimension counts ("7
 * dimensions", "4 pillars"). Nobody publishes what happened AFTER their
 * verdicts. This page does: every score vet402 issues becomes a watched
 * verdict, the outcome-detector and partner reports label what the wallet
 * actually did next, and the aggregate lands here — including the number
 * that flatters us least (BLOCK verdicts later confirmed legitimate).
 *
 * The empty state is deliberate and honest: methodology first, numbers when
 * the sample is real. A page that only appears once the numbers look good
 * would defeat its own point.
 *
 * 2026-08-13 vet402: typeset as §-numbered sections of the memo. The two
 * headline figures were cards; they are now the top two rows of a fact table,
 * because the whole claim of this page is that these are measurements and a
 * measurement belongs in a column with the others.
 */

export const metadata: Metadata = pageMetadata({
  title: "Measured accuracy",
  description:
    "vet402 publishes what happened after its verdicts: the share of ALLOW verdicts that later showed adverse activity, and the share of BLOCK verdicts we got wrong.",
  path: "/accuracy",
});

export const revalidate = 600;

/**
 * 2026-09-04 監査 F5: 3 表が全部 0 件のとき、この頁は「何も測っていない会社」に見えた。
 * 観測所は毎日測っていて、その実数は state API が正典。ここは API の JSON を fetch で
 * 引く（reader を直接呼ばない——引用先と同じ数を出すため）。取れなければ何も出さない。
 */
type ObservatoryScale = {
  snapshotDate: string | null;
  totalEndpoints: number;
  activeEndpoints: number;
  publishedPass: number;
  l1: { attempts: number; settled: number };
};

async function fetchObservatoryScale(): Promise<ObservatoryScale | null> {
  try {
    const res = await fetch(`${SITE_URL}/api/v1/observatory/state`, {
      next: { revalidate: 600 },
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      totalEndpoints?: unknown;
      activeEndpoints?: unknown;
      publishedPass?: unknown;
      l1?: { attempts?: unknown; settled?: unknown };
      latestSnapshot?: { snapshotDate?: unknown } | null;
    };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const totalEndpoints = n(j.totalEndpoints);
    if (totalEndpoints === 0) return null;
    return {
      snapshotDate: typeof j.latestSnapshot?.snapshotDate === "string" ? j.latestSnapshot.snapshotDate : null,
      totalEndpoints,
      activeEndpoints: n(j.activeEndpoints),
      publishedPass: n(j.publishedPass),
      l1: { attempts: n(j.l1?.attempts), settled: n(j.l1?.settled) },
    };
  } catch {
    return null;
  }
}

function Rate({ value }: { value: number | null }) {
  if (value === null) {
    // 2026-08-12: zinc-400 は白地 2.62:1 で AA 不合格 → 現在は brand-lift (5.61:1)。
    return <span className="text-brand-lift">insufficient data</span>;
  }
  return <span className="text-brand-deep">{value}%</span>;
}

export default async function AccuracyPage() {
  let report: AccuracyReport;
  try {
    report = computeAccuracyReport(await fetchAccuracyRows(90));
  } catch {
    report = computeAccuracyReport([]);
  }

  // Operator benchmark — self-seeded on purpose, and therefore fetched,
  // computed, and rendered as its OWN section: fetchAccuracyRows excludes
  // these rows at the SQL layer, so nothing here can pad the external
  // figures above. See src/lib/benchmark/dataset.ts for the address sources.
  let benchmark: BenchmarkReport;
  try {
    benchmark = computeBenchmarkReport(await fetchBenchmarkRows(90));
  } catch {
    benchmark = computeBenchmarkReport([]);
  }

  const hasAnyData = report.observedVerdicts > 0;
  const hasBenchmarkData = benchmark.knownBad.total + benchmark.knownGood.total > 0;
  const scale = !hasAnyData && !hasBenchmarkData ? await fetchObservatoryScale() : null;
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "vet402 accuracy ledger",
    description:
      "What happened after vet402's own verdicts: the share of ALLOW verdicts with later adverse activity, and the share of BLOCK verdicts later confirmed wrong, over a rolling 90-day window.",
    url: `${SITE_URL}/accuracy`,
    creator: { "@type": "Organization", name: "vet402", url: SITE_URL },
    temporalCoverage: "R/P90D",
    distribution: {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${SITE_URL}/api/v1/accuracy`,
    },
    variableMeasured: [
      "observed verdicts",
      "ALLOW verdicts with adverse outcome",
      "BLOCK verdicts confirmed wrong",
    ],
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Accuracy", path: "/accuracy" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(datasetJsonLd) }}
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
            <span>Report: accuracy of issued verdicts</span>
            <span>
              Window:{" "}
              {/* シアンはこの頁の1点。実測の窓という事実に充てている。 */}
              <span className="text-signal">rolling 90 days</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>Score methodology v{report.methodologyVersion}</span>
            <span>Aggregate counts only</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Measured, not asserted</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            Most trust products tell you how many dimensions their score has. The only number that
            matters is what happened <em>after</em> the verdict. Every score vet402 issues becomes a
            watched event: an on-chain detector and partner reports label what the wallet actually
            did next, and the aggregate is published here &mdash;{" "}
            <strong>including the number that flatters us least.</strong> This ledger is for
            score verdicts (ALLOW / WARN / BLOCK), not observatory L0–L2 facts —{" "}
            <Link href="/observatory" className="doc-link">
              those live on the observatory
            </Link>
            .
          </p>
        </div>

        {scale && (
          <p className="doc-note mt-6 max-w-[70ch]">
            The three tables below are empty in the current window. The observatory, which this ledger does not
            cover, is not: {scale.totalEndpoints.toLocaleString("en-US")} endpoints on record (
            {scale.activeEndpoints.toLocaleString("en-US")} active), {scale.publishedPass.toLocaleString("en-US")}{" "}
            with a published L0 pass, {scale.l1.attempts.toLocaleString("en-US")} paid purchase attempts of which{" "}
            {scale.l1.settled.toLocaleString("en-US")} settled with an on-chain receipt
            {scale.snapshotDate ? `, as of the ${scale.snapshotDate} catalog snapshot` : ""}. Counts as reported by{" "}
            <code className="text-brand-deep">GET /api/v1/observatory/state</code> (<code>l1.attempts</code>,{" "}
            <code>l1.settled</code>); they are catalog measurements, not score verdicts, and do not enter the
            rates on this page.
          </p>
        )}

        {/* ===== 1. External usage =====
            the operator benchmark below is deliberately NOT part of these
            figures (excluded at the SQL layer, outcome-reader.ts): self-seeded
            rows padding the external sample would be exactly the
            asserted-not-measured move this page exists against. */}
        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>External usage</span>
        </h2>
        <p className="doc-p">
          Verdicts requested by API users, judged by what the wallet did afterwards. Operator-run
          benchmark scans are excluded from every number in this section and reported separately in
          §2.
        </p>

        <TableScroll label="Headline accuracy figures over the last 90 days">
          <table className="fact-table">
            <caption className="sr-only">
              Headline accuracy figures over the last 90 days
            </caption>
            <thead>
              <tr>
                <th scope="col">Measurement</th>
                <th scope="col" className="num">
                  Rate
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  ALLOW verdicts that later showed adverse activity
                </td>
                <td className="num whitespace-nowrap">
                  <Rate value={report.allowAdverseRate} />
                </td>
              </tr>
              <tr>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  BLOCK verdicts later confirmed legitimate (our false positives)
                </td>
                <td className="num whitespace-nowrap">
                  <Rate value={report.blockFalsePositiveRate} />
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>

        {/* 2026-08-06 (320px persona audit A-6): the column gutters pushed the
            rightmost column — the single most important number on this page —
            off screen at 320px. The table now scrolls inside its own container
            and the page itself never scrolls sideways. */}
        <TableScroll label="Outcome counts by recommendation over the last 90 days">
          <table className="fact-table">
            <caption className="sr-only">
              Outcome counts by recommendation over the last 90 days
            </caption>
            <thead>
              <tr>
                <th scope="col">Verdict</th>
                <th scope="col" className="num">
                  Resolved
                </th>
                <th scope="col" className="num">
                  Went bad
                </th>
                <th scope="col" className="num">
                  Stayed good
                </th>
                <th scope="col" className="num">
                  Adverse rate
                </th>
              </tr>
            </thead>
            <tbody>
              {report.byRecommendation.map((row) => (
                <tr key={row.recommendation}>
                  <td>
                    <VerdictBadge verdict={row.recommendation} />
                  </td>
                  <td className="num">{row.resolved}</td>
                  <td className="num">{row.wentBad}</td>
                  <td className="num">{row.stayedGood}</td>
                  <td className="num whitespace-nowrap">
                    <Rate value={row.adverseRate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        <p className="doc-note mt-5 max-w-[70ch]">
          {hasAnyData ? (
            <>
              {report.observedVerdicts.toLocaleString("en-US")} verdicts with recorded outcomes in
              the last 90 days ({report.resolvedVerdicts.toLocaleString("en-US")} resolved to
              good/bad, {report.neutralOnlyVerdicts.toLocaleString("en-US")} neutral,{" "}
              {report.partnerReportedVerdicts.toLocaleString("en-US")} partner-reported).
            </>
          ) : (
            <>
              No resolved outcomes in the current window yet. The collection pipeline is live —
              this page fills in as verdicts age and outcomes land. We publish the methodology first
              and the numbers when the sample is real, because an accuracy page that appears only
              once the numbers look good would defeat its own point.
            </>
          )}{" "}
          Raw JSON: <code className="text-brand-deep">GET /api/v1/accuracy</code>.
        </p>

        {/* 2026-08-06 (L4 legal review): publishing measured rates is the point
            of this page, but a bare percentage reads as a performance promise —
            and once real numbers land here, that is close to an implied
            warranty of accuracy. Saying out loud that these are backward-looking
            keeps the page honest without weakening it. Mirrors ToS section 5. */}
        <p className="doc-note mt-4 max-w-[70ch]">
          These figures are historical: they describe verdicts vet402 has already issued and
          outcomes we have already observed, over a rolling 90-day window. They are not a forecast,
          a service-level commitment, or a warranty of the accuracy of any future score. Past rates
          can and will move as the sample grows and as the behavior we score changes. See the{" "}
          <Link href="/legal/terms" className="doc-link">
            Terms of Service
          </Link>{" "}
          for what that means in practice.
        </p>

        {/* ===== 2. Operator benchmark =====
            self-seeded and labeled as such. Hiding the origin of these rows
            would turn "measured, not asserted" into a fabrication, so the
            section says who ran the scans in its first sentence. */}
        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Operator benchmark (labeled addresses)</span>
        </h2>
        <p className="doc-p">
          These scans are run by us, not by customers &mdash; a controlled test, published
          separately so it can never be mistaken for (or padded into) external usage. Weekly, the
          engine scores a fixed, versioned set of addresses whose real-world outcome is already
          public knowledge: &ldquo;known bad&rdquo; addresses from the US OFAC sanctions (SDN) list,
          and &ldquo;known good&rdquo; addresses of long-operating, publicly identified
          organizations and individuals. The engine should refuse the former and pass the latter;
          each address counts once, using its most recent scan.
        </p>

        {hasBenchmarkData ? (
          <>
            <TableScroll label="Operator benchmark results over the last 90 days">
              <table className="fact-table">
                <caption className="sr-only">Operator benchmark results over the last 90 days</caption>
                <thead>
                  <tr>
                    <th scope="col">Measurement</th>
                    <th scope="col" className="num">
                      Rate
                    </th>
                    <th scope="col" className="num">
                      Counts
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                      Known-bad addresses flagged (BLOCK or WARN)
                    </td>
                    <td className="num whitespace-nowrap">
                      <Rate value={benchmark.knownBad.detectionRate} />
                    </td>
                    {/* 2026-08-13 UX監査R1 [A2]: 開示が非対称だった。既知良の行は
                        「0 allowed / 17 warned / 0 blocked」と3値すべて出しているのに、
                        既知悪はここが「25 of 25 flagged, 0 allowed」で、
                        24 BLOCK / 1 WARN という内訳が落ちていた（API の
                        /api/v1/accuracy には最初から出ている）。しかもその1件の
                        WARN は、リスト中で最も名の知れた Lazarus/Ronin のアドレス。
                        自分に都合の悪い側だけ粒度が粗いのは、この頁の存在理由に
                        反する。同じ粒度で出す。 */}
                    <td className="num whitespace-nowrap text-brand-lift">
                      {benchmark.knownBad.blocked} of {benchmark.knownBad.total} blocked,{" "}
                      {benchmark.knownBad.warned} warned, {benchmark.knownBad.missed} allowed
                    </td>
                  </tr>
                  <tr>
                    <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                      Known-good addresses wrongly blocked (our false positives)
                    </td>
                    <td className="num whitespace-nowrap">
                      <Rate value={benchmark.knownGood.falsePositiveRate} />
                    </td>
                    <td className="num whitespace-nowrap text-brand-lift">
                      {benchmark.knownGood.allowed} of {benchmark.knownGood.total} allowed,{" "}
                      {benchmark.knownGood.warned} warned, {benchmark.knownGood.blocked} blocked
                    </td>
                  </tr>
                </tbody>
              </table>
            </TableScroll>
            {/* 2026-08-13 UX監査2巡目 [M7]: 「誤ブロック 0%」は自賛に読める。
                実測では 17件の known-good のうち ALLOW は0件で、17件全部が WARN
                だった — つまり 0% が言っているのは「1件も BLOCK しなかった」で
                あって「全部を通した」ではない。数字の隣で自分から言う。
                件数はレポートから引く（ここに 17 を焼き込むと、集合が変わった
                翌週に嘘になる）。 */}
            {/* 2026-08-13 UX監査R1 [A2] の続き。既知良の 0% には既に自分から
                但し書きを付けていたのに、既知悪の 100% には付けていなかった。
                100% が言っているのは「1件も素通りさせなかった」であって
                「全部を止めた」ではない — WARN は検知に数えているが、
                WARN のまま通す実装であれば止まらない。件数はレポートから
                引く（焼き込むと集合が変わった翌週に嘘になる）。 */}
            {benchmark.knownBad.warned > 0 ? (
              <p className="doc-note mt-5 max-w-[70ch]">
                On that {benchmark.knownBad.detectionRate ?? 0}%: a detection here counts BLOCK{" "}
                <em>or</em> WARN. {benchmark.knownBad.warned} of the {benchmark.knownBad.total}{" "}
                known-bad addresses{" "}
                {benchmark.knownBad.warned === 1 ? "scores" : "score"} WARN rather than BLOCK, so
                an integration that lets WARN through would pay{" "}
                {benchmark.knownBad.warned === 1 ? "it" : "them"}. The SDK and the middleware
                default to allow-only, which is why that default exists.
              </p>
            ) : null}
            {benchmark.knownGood.total > 0 && benchmark.knownGood.allowed === 0 ? (
              <p className="doc-note mt-5 max-w-[70ch]">
                On that 0%: a false positive here counts only a BLOCK on a known-good address.
                None of the {benchmark.knownGood.total} known-good addresses currently scores
                ALLOW &mdash; {benchmark.knownGood.warned} of them score WARN &mdash; so 0% means
                &ldquo;none were blocked&rdquo;, not &ldquo;all were passed&rdquo;. The engine is
                cautious on this set, not accurate on it.
              </p>
            ) : null}
            <p className="doc-note mt-5 max-w-[70ch]">
              {benchmark.scans.toLocaleString("en-US")} benchmark scans in the last 90 days
              {benchmark.lastScanAt
                ? `, most recent ${new Date(benchmark.lastScanAt).toISOString().slice(0, 10)}`
                : ""}
              . Address set and per-address sources are versioned in the codebase (§3).
            </p>
          </>
        ) : (
          <p className="doc-note mt-5 max-w-[70ch]">
            No benchmark scans in the current window yet &mdash; the first weekly pass publishes
            here automatically.
          </p>
        )}

        {/* ===== 3. Methodology ===== */}
        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>Score methodology (v{report.methodologyVersion})</span>
        </h2>

        <div className="mt-6 space-y-5">
          <MethodItem no="3.1" title="Outcome sources">
            Auto-detected on-chain activity (drain patterns, sustained healthy activity, dormancy,
            ownership changes, negative on-chain feedback) and partner reports (
            {/* break-all: this 41-char path has no break opportunity, so it
                overflowed a 320px viewport by 26px and took the page into
                horizontal scroll (2026-08-06 audit A-4). */}
            <code className="break-all text-brand-deep">
              POST /api/v1/events/:trustEventId/outcome
            </code>
            : confirmed fraud, confirmed legitimate, chargeback/dispute).
          </MethodItem>
          <MethodItem no="3.2" title="Classification">
            Rug-pull outflow, negative feedback, confirmed fraud and chargebacks count as{" "}
            <em>bad</em>. Sustained healthy activity and confirmed-legitimate count as <em>good</em>.
            Dormancy and ownership changes are <em>neutral</em> &mdash; silence is not vindication,
            so neutral outcomes never move a rate in either direction.
          </MethodItem>
          <MethodItem no="3.3" title="Conflicts">
            When one verdict accumulates conflicting outcomes, a partner confirmation beats auto
            detection; within the same tier, <em>bad beats good</em> &mdash; ties count against us,
            not for us.
          </MethodItem>
          <MethodItem no="3.4" title="Minimum sample">
            A rate is published only at {report.minSample}+ resolved verdicts for that bucket; below
            that the page says &ldquo;insufficient data&rdquo; rather than printing noise.
          </MethodItem>
          <MethodItem no="3.5" title="Window">
            Rolling 90 days, aggregate counts only &mdash; no wallet addresses, no agent ids, no
            per-customer data on this page or in the API response.
          </MethodItem>
          <MethodItem no="3.6" title="Operator benchmark">
            Run by the operator against a fixed, versioned address set and stored with a dedicated
            source tag (<code className="text-brand-deep">operator_benchmark</code>) so it is
            excluded from all external figures at the query level. Known-bad = current ETH entries
            of the US Treasury OFAC SDN list (public domain; retrieved via the nightly extraction at{" "}
            {/* same break-all treatment as the endpoint path above — long URLs
                must not force horizontal scroll at 320px */}
            <code className="break-all text-brand-deep">
              github.com/0xB10C/ofac-sanctioned-digital-currency-addresses
            </code>
            ). Known-good = long-operating addresses publicly attributed via official publications,
            on-chain ENS names, or public label consensus, with no adverse reports at assembly and
            verified activity on Base &mdash; the chain the engine scores &mdash; so the test
            measures discrimination, not chain coverage. Scoring uses the same engine and
            fail-closed rules as a live lookup, with no customer list attached. Judgment: flagging
            (BLOCK/WARN) a known-bad address is a detection and allowing it is a miss; allowing a
            known-good address is correct and blocking it is a false positive, with warnings on good
            addresses reported separately. The full address set with per-address sources lives in
            the codebase at{" "}
            <code className="break-all text-brand-deep">src/lib/benchmark/dataset.ts</code>, and
            rates follow the same {report.minSample}+ minimum-sample rule.
          </MethodItem>
        </div>

        {/* ===== 4. Data reuse / Citation =====
            2026-08-13 UX監査R1 [B1]: 引用許諾は public/llms.txt にしか無く、
            robots.txt が Allow するだけで、サイト内から llms.txt へのリンクは
            0本だった。つまり機械には読めて人間には到達できない。研究者ペルソナは
            この頁の数字を引きたくて、許諾が見つからずに止まった。文言は
            llms.txt の Citation / Corrections 節と同じ趣旨をそのまま人間向けの
            位置に置く（新しい条件は付けていない）。 */}
        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Data reuse and citation</span>
        </h2>

        <div className="mt-6 space-y-5">
          <MethodItem no="4.1" title="You may cite this">
            The content on this site &mdash; front page, API docs, FAQ, this accuracy ledger, the
            blog &mdash; may be quoted and cited, by people and by machines, as long as the source
            is credited with the corresponding vet402.com URL. No permission request is needed and
            nothing has to be asked of us first.
          </MethodItem>
          <MethodItem no="4.2" title="Cite the numbers with their window">
            Every figure on this page is a rolling 90-day aggregate that moves as the sample grows.
            A citation that carries the retrieval date and the window is reproducible; one that
            prints a bare percentage is not. The same numbers are available as JSON at{" "}
            <code className="text-brand-deep">GET /api/v1/accuracy</code>, with a{" "}
            <code className="text-brand-deep">generatedAt</code> timestamp to quote.
          </MethodItem>
          <MethodItem no="4.3" title="If a figure about you is wrong">
            There is a free, key-less correction route open to anyone, customer or not &mdash; see{" "}
            <Link href="/legal/terms#corrections" className="doc-link">
              section 8 of the Terms of Service
            </Link>
            . Corrections we issue are published in the{" "}
            <Link href="/corrections" className="doc-link">
              corrections log
            </Link>
            .
          </MethodItem>
          <MethodItem no="4.4" title="The machine-readable copy">
            The same statement, plus the site map and the open API paths, is served for automated
            readers at{" "}
            <a href="/llms.txt" className="doc-link">
              /llms.txt
            </a>
            .
          </MethodItem>
        </div>

        <div className="dashbox mt-10 max-w-[64ch]">
          <p className="doc-caption">Report an outcome</p>
          <p className="mt-3 text-brand">
            Run a payment provider and want your outcomes counted?{" "}
            <Link href="/signup" className="doc-link">
              Get an API key
            </Link>{" "}
            and report them &mdash; partner-confirmed outcomes take precedence over our
            auto-detection.
          </p>
        </div>
      </article>
    </main>
  );
}

function MethodItem({
  no,
  title,
  children,
}: {
  no: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <span className="w-[4ch] shrink-0 text-brand-lift">{no}</span>
      <p className="min-w-0 max-w-[64ch] text-brand">
        <strong>{title}.</strong> {children}
      </p>
    </div>
  );
}
