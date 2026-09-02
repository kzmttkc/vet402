import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";
import { formatUsdcUnits } from "@/lib/util/usd";
import {
  getCoverageShare,
  getObservatoryStats,
} from "@/lib/observatory/reader";
import { computeSpendGuardBacktest } from "@/lib/observatory/backtest";
import { getDecisionFeed, getLatestSettledReceipts } from "@/lib/observatory/decisions";
import { getAnchors } from "@/lib/observatory/anchors";
import { explorerTxUrl } from "@/lib/observatory/chains";
import { TableScroll } from "@/components/site/TableScroll";

/**
 * /impact — 公共財としての貢献を1ページで（SPEC20 A9・GTM Month1）。
 *
 * 新しい数字は作らない: 既存の公開リーダーを合成し、助成金/ハッカソン
 * 審査員が「エコシステムへ何を無償で供給しているか」を1画面・全て検証可能
 * リンク付きで読めるようにするだけ。主張は分母付きの事実に限る。
 */

export const metadata: Metadata = pageMetadata({
  title: "Impact — a public good, in numbers you can check",
  description:
    "What vet402 gives the x402 agent economy for free: coverage of listed endpoints, real purchases published with evidence, refusals and losses alike, and a hash-chained ledger — every figure links to the API that produces it.",
  path: "/impact",
});

export const revalidate = 900;


export default async function ImpactPage() {
  const [stats, coverage, backtest, decisions, anchors, receipts] = await Promise.all([
    getObservatoryStats(),
    getCoverageShare(),
    computeSpendGuardBacktest().catch(() => null),
    getDecisionFeed(30).catch(() => null),
    getAnchors(1).catch(() => []),
    getLatestSettledReceipts(5).catch(() => []),
  ]);
  const latestAnchor = anchors[0] ?? null;

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Public-good contribution, verifiable</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory/state" className="underline">
                State of x402
              </Link>
              {" · "}
              <Link href="/decisions" className="underline">
                Decisions
              </Link>
            </span>
            <span>Every figure links to its API</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Impact</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            vet402 measures the x402 agent-payment economy by <strong>actually using it</strong>,
            and gives the results away: the data is public, the code is MIT, the ledger is
            hash-anchored (a daily prev-hash chain; on-chain anchoring is not yet enabled — see
            §4) so nobody can quietly rewrite it. This page states the contribution as
            numbers — and every number below links to the endpoint that produces it, so you can
            check it rather than trust it.
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Coverage of the ecosystem</span>
        </h2>
        <p className="doc-p">
          <strong>{stats.totalEndpoints.toLocaleString()}</strong> endpoints on record;{" "}
          <strong>{stats.activeEndpoints.toLocaleString()}</strong> currently listed.{" "}
          {coverage.pct === null ? (
            "Coverage is starting up."
          ) : (
            <>
              <strong>{coverage.measuredLast7d.toLocaleString()}</strong> of them (
              <strong>{coverage.pct}%</strong>) carry an independent L0 measurement from the last 7
              days — the machine definition of &quot;under regular verification&quot;.
            </>
          )}{" "}
          <Link href="/api/v1/observatory/state" className="underline">
            /api/v1/observatory/state
          </Link>
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Real purchases, published with evidence</span>
        </h2>
        <p className="doc-p">
          <strong>{stats.l1.attempts.toLocaleString()}</strong> real purchase attempts across{" "}
          <strong>{stats.l1.endpointsAttempted.toLocaleString()}</strong> endpoints;{" "}
          <strong>{stats.l1.settled.toLocaleString()}</strong> settled with an on-chain receipt.
          Successes and non-settling losses are published with the same weight — a receipt series
          per endpoint, transaction hashes included.{" "}
          <Link href="/api/v1/observatory/export.csv" className="underline">
            export.csv
          </Link>
        </p>
        {/* 2026-09-02 監査 F4: このページに tx ハッシュが 0 本だった。「受領証がある」が
            主張なら、受領証そのものへ 1 クリックで着けなければならない。既存の数字の
            出所は変えず、直近 5 件を本文に載せる。 */}
        {receipts.length > 0 && (
          <>
            <p className="doc-caption mt-6">Latest settled receipts</p>
            <TableScroll label="Latest settled receipts, newest first">
              <table className="fact-table">
                <caption className="sr-only">Latest settled receipts, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Attempted (UTC)</th>
                    <th scope="col">Endpoint</th>
                    <th scope="col">Receipt (tx)</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((r) => {
                    const url = explorerTxUrl(r.network, r.txHash);
                    const short = `${r.txHash.slice(0, 10)}…${r.txHash.slice(-4)}`;
                    return (
                      <tr key={`${r.endpointId}-${r.txHash}`}>
                        <td className="whitespace-nowrap text-brand-lift">
                          {r.at.slice(0, 16).replace("T", " ")}
                        </td>
                        <td className="break-all">
                          <Link href={`/observatory/e/${r.endpointId}`} className="underline">
                            {r.resourceKey}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap">
                          {url ? (
                            <a href={url} className="underline" rel="noopener noreferrer">
                              <code>{short}</code>
                            </a>
                          ) : (
                            <code title={r.txHash}>{short}</code>
                          )}
                        </td>
                        <td className="num">{formatUsdcUnits(r.amountUnits)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </>
        )}

        {decisions && (
          <>
            <h2 className="sec-head">
              <span className="sec-no">3.</span>
              <span>Losses an agent avoids by reading the signals</span>
            </h2>
            <p className="doc-p">
              In the last 30 days vet402 <strong>refused {decisions.totals.refused}</strong>{" "}
              payments before signing (overcharging or unpayable walls) and published every
              decision.
              {backtest && (
                <>
                  {" "}Across the whole ledger, {backtest.avoided.count} signed attempts carried a
                  prior public failure signal and <strong>none of them settled</strong> (
                  {formatUsdcUnits(backtest.avoided.spentUnits)} that an agent honoring the signals would not
                  have lost), while {backtest.forgone.count} signalled attempts settled anyway.
                </>
              )}{" "}
              <Link href="/api/v1/observatory/decisions" className="underline">
                /decisions
              </Link>
            </p>
          </>
        )}

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Integrity: the record cannot be quietly rewritten</span>
        </h2>
        <p className="doc-p">
          {latestAnchor ? (
            <>
              The purchase ledger is a daily hash chain. Latest root ({latestAnchor.day}):{" "}
              <code>{latestAnchor.rootHash.slice(0, 16)}…</code> over{" "}
              {latestAnchor.entryCount.toLocaleString()} entries. Rewriting any past row breaks every
              later root, and the projection is open source, so a third party can verify the chain
              from the public API alone.
            </>
          ) : (
            "The purchase ledger is a daily hash chain; anchoring begins with the first anchored day."
          )}{" "}
          <Link href="/api/v1/observatory/anchors" className="underline">
            /anchors
          </Link>
        </p>

        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>What is free, and reproducible</span>
        </h2>
        <p className="doc-p">
          All measurement surfaces above are key-less and public. The verification stack is MIT and
          self-hostable (<code>docker compose up</code>), and anyone can reproduce a probe or see
          exactly what a buyer would sign without signing anything —{" "}
          <a className="underline" href="https://github.com/kzmttkc/vet402">
            source
          </a>{" "}
          (<code>cli/</code>). SDKs for TypeScript and Python, plus MCP / LangChain / ElizaOS /
          solana-agent-kit adapters, make &quot;check trust before paying&quot; a one-liner —{" "}
          <Link href="/docs/api" className="underline">
            API reference
          </Link>
          . The operating model is stated openly at{" "}
          <Link href="/operations" className="underline">
            /operations
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
