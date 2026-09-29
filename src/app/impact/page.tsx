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
    "What vet402 gives the x402 economy for free: endpoint coverage, real purchases with evidence, and a hash-chained ledger; every figure links to its API.",
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
            and gives the results away: the data is public, the code is MIT, and the purchase
            ledger gets a daily prev-hash chain root, kept by vet402 itself (on-chain anchoring is
            not yet enabled — see §4). A reader who saves a root can later tell whether the
            published one changed; the chain does not stop vet402 from editing rows. This page states the contribution as
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
          <strong>{stats.l1.settled.toLocaleString()}</strong> settled on-chain. Of those settled attempts,{" "}
          {(stats.l1.settled - stats.l1.settledLateLinked).toLocaleString()} carry a transaction the seller named
          in its own settlement receipt and {stats.l1.settledLateLinked.toLocaleString()} a transaction the seller
          did not name, which vet402&apos;s own settlements index found afterwards (<code>settlement_source</code>{" "}
          <code>vet402_index</code> in the export). By endpoint:{" "}
          {stats.l1.endpointsSettledSellerReceipt.toLocaleString()} endpoints have at least one seller-named
          receipt and {stats.l1.endpointsSettledIndexOnly.toLocaleString()} have index-found transfers and no
          seller-named receipt.
          Settled attempts and attempts that did not settle are published with the same weight — a receipt series
          per endpoint, transaction hashes included.{" "}
          <Link href="/api/v1/observatory/export.csv" className="underline">
            export.csv
          </Link>
        </p>
        {/* 2026-09-04 監査 E: 「attempts」は API ごとに定義が違い 4 値あった。この頁の数字は
            state API の l1.attempts / l1.settled だけを引く。出所と定義を数字の隣に書く。 */}
        <p className="doc-note mt-3 max-w-[62ch]">
          Attempts and settled as reported by <code>/api/v1/observatory/state</code> (<code>l1.attempts</code>: paid
          requests whose payment was signed and sent; <code>l1.settled</code>: transfer re-read on-chain;{" "}
          <code>l1.settledLateLinked</code>: the index-found part of it). The CSV export applies its own row
          definition and can count differently.
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
              <span>What an agent skips by reading the signals</span>
            </h2>
            <p className="doc-p">
              In the last 30 days vet402 <strong>refused {decisions.totals.refused}</strong> of{" "}
              {decisions.totalDecisions.toLocaleString()} decisions before signing (overcharging or
              unpayable walls) and published every one of them.
              {backtest && (
                <>
                  {" "}Across the whole ledger, {backtest.avoided.count} of{" "}
                  {backtest.attemptsTotal.toLocaleString()} signed attempts with a final outcome carried a
                  prior public failure signal and <strong>did not settle</strong> (
                  {formatUsdcUnits(backtest.avoided.spentUnits)} signed and put at stake with no confirmed
                  transfer on-chain — exposure an agent honoring the signals would not have taken, not money
                  lost), while {backtest.forgone.count} signalled attempts settled anyway and would have been
                  skipped too (definition:
                  signed attempts preceded by a public failure signal, a subset of the attempts in §2 that leaves
                  out rows still awaiting on-chain re-read (<code>settle_claimed</code>) and rows from the window when
                  vet402&apos;s own payer wallet was out of USDC (<code>payer_unfunded</code>), from{" "}
                  <code>/api/v1/observatory/backtest</code>).
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
          <span>Integrity: an operator-kept hash chain</span>
        </h2>
        <p className="doc-p">
          {latestAnchor ? (
            <>
              The purchase ledger is a daily hash chain. Latest root ({latestAnchor.day}):{" "}
              <code>{latestAnchor.rootHash.slice(0, 16)}…</code> over that day&apos;s{" "}
              {latestAnchor.entryCount.toLocaleString()} entries. A root covers that day&apos;s rows as
              they stood when it was computed (the latest day is recomputed while late rows arrive).
              Rows are still updated after that by design &mdash; a claimed settlement verified
              on-chain, a correction &mdash; so an older root describes the ledger as it was then, and
              today&apos;s rows are not expected to reproduce it; published status changes are listed
              in <Link href="/corrections" className="underline">/corrections</Link>. From the public API alone a third party can check that each day&apos;s root
              links to the previous day&apos;s and that no day is missing (<code>cli/verify-anchors.ts</code>).
              Recomputing a root itself needs the raw purchase rows, and those are not published in
              full: the open-source projection (<code>src/lib/observatory/anchors.ts</code>) hashes
              fields <code>export.csv</code> leaves out — the row id, the payer, the asset, sub-second
              times, and the statuses the export omits. The entry count is the rows that anchor
              hashed, which is not the attempt count in §2.{" "}
              {latestAnchor.anchoredTx ? (
                <>
                  That root is also fixed outside vet402 in transaction{" "}
                  <code>{latestAnchor.anchoredTx.slice(0, 16)}…</code>.
                </>
              ) : (
                <>
                  The chain is kept by the operator and is not yet fixed anywhere outside vet402
                  (the <code>anchoredTx</code> field is empty), so the operator could still
                  recompute the whole chain. A reader who saves a root today can detect that later.
                </>
              )}
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
          (<code>cli/</code>). The TypeScript SDK (<code>@vet402/sdk</code>) and the MCP server
          (<code>@vet402/mcp-server</code>) are published on npm. A Python SDK exists in the
          repository but is not yet published to PyPI, and the LangChain, ElizaOS and
          solana-agent-kit integrations are example code in the repository&apos;s{" "}
          <code>examples/</code>, not packages —{" "}
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
