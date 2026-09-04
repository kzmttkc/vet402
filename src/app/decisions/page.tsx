import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";
import { formatUsdcUnits } from "@/lib/util/usd";
import { getDecisionFeed } from "@/lib/observatory/decisions";
import { computeSpendGuardBacktest } from "@/lib/observatory/backtest";
import { TableScroll } from "@/components/site/TableScroll";
import { explorerTxUrl } from "@/lib/observatory/chains";

/**
 * /decisions — 実資金の判定台帳（次波①・SPEC20 A4の実装形）。
 * 「拒否デモ」を演出でやらない: ここに流れるのは日次L1が実費で下した
 * 判定そのもの。拒否も、支払って決済されなかった損失も、同じ重みで並ぶ。
 */

export const metadata: Metadata = pageMetadata({
  title: "Decisions — pay or refuse, with real money",
  description:
    "Every decision the daily verifier actually made with its own funds: refusals before signing (overcharging walls, unpayable walls) and outcomes after paying — settled receipts and losses alike.",
  path: "/decisions",
});

export const revalidate = 600;

const DECISION_LABEL: Record<string, string> = {
  refused_price_mismatch: "REFUSED — wall demanded more than declared",
  refused_payto_mismatch: "REFUSED — wall named a payee other than the declared one",
  refused_payto_operator_self: "REFUSED — wall named our own receiving address",
  refused_over_cap: "REFUSED — price over hard cap",
  refused_wall_unpayable: "REFUSED — wall not machine-payable",
  paid_settled: "PAID — settled, receipt on-chain",
  paid_delivered_no_receipt: "PAID — delivered, no receipt",
  paid_settlement_claim_unverifiable: "PAID — settlement claim not verifiable",
  paid_settlement_claim_unverified: "PAID — settlement claim not yet re-read on-chain",
  paid_settlement_claim_refuted: "PAID — settlement claim refuted on-chain",
  paid_no_settlement: "PAID — no settlement (loss, published)",
};


/** 見出し・本文・API リンクが同じ窓を指すように 1 箇所で持つ。 */
const DECISION_WINDOW_DAYS = 30;

export default async function DecisionsPage() {
  const feed = await getDecisionFeed(DECISION_WINDOW_DAYS);
  const backtest = await computeSpendGuardBacktest().catch(() => null);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Register: pay-or-refuse decisions (last {DECISION_WINDOW_DAYS} days)</span>
            {/* 2026-09-04 外部監査 E・P0-4: この 3 つの数は "last 30 days" と名乗りながら
                LIMIT 200 で切ったあとの行を数えていた。合計は窓全体を SQL で数える。 */}
            <span>
              Refused: <span className="text-signal">{feed.totals.refused}</span> · Paid &amp;
              settled: <span className="text-signal">{feed.totals.paidSettled}</span> · Paid, no
              settlement: <span className="text-signal">{feed.totals.paidNoSettlement}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory" className="underline">
                Observatory
              </Link>
              {" · "}
              <Link href="/observatory/state" className="underline">
                State of x402
              </Link>
            </span>
            <span>Machine: /api/v1/observatory/decisions</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">Decisions</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:gap-0">
          <p className="shrink-0 text-brand-deep sm:w-[10ch]">Abstract</p>
          <p className="min-w-0 max-w-[62ch] text-brand">
            An agent&apos;s hardest question is <em>pay or don&apos;t pay</em>. This register is
            how vet402 answers it every day with its own funds: walls that demanded more than
            they declared were <strong>refused before signing</strong>; walls that passed the
            gates were paid, and the outcome — settlement receipt or loss — is published with
            the same weight. Nothing here is simulated.
            {backtest && (
              <>
                {" "}Across the whole ledger, {backtest.avoided.count} signed attempts carried a
                prior published failure signal and none of them settled ({formatUsdcUnits(backtest.avoided.spentUnits)}{" "}
                lost) — while {backtest.forgone.count} signalled attempts settled anyway. An agent
                honoring the signals keeps the wins and skips the losses.
              </>
            )}
          </p>
        </div>

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>The register</span>
        </h2>
        <p className="doc-p">
          The three counts in the header are the whole {DECISION_WINDOW_DAYS}-day window
          ({feed.totalDecisions.toLocaleString()} decisions).
          {feed.totalDecisions > feed.rows.length ? (
            <>
              {" "}
              The table below shows the newest {feed.rows.length.toLocaleString()} of them; the full
              window is at{" "}
              <Link href={`/api/v1/observatory/decisions?days=${DECISION_WINDOW_DAYS}`} className="underline">
                /api/v1/observatory/decisions
              </Link>
              , and the whole ledger at <code>/api/v1/observatory/export.csv</code>.
            </>
          ) : (
            " Every decision in the window is in the table below."
          )}
        </p>
        {feed.rows.length === 0 ? (
          <p className="doc-p">No decisions in this window.</p>
        ) : (
          <TableScroll label="Pay-or-refuse decisions, newest first">
            <table className="fact-table">
              <caption className="sr-only">Pay-or-refuse decisions, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When (UTC)</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Decision</th>
                  <th scope="col" className="num">
                    At stake
                  </th>
                  <th scope="col">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {feed.rows.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td className="whitespace-nowrap text-brand-lift">{r.at.slice(0, 16).replace("T", " ")}</td>
                    {/* 2026-09-02 監査 F3: endpoint 名は記録頁へ、受領証はチェーンのエクスプローラへ。 */}
                    <td className="break-all text-brand">
                      <Link href={`/observatory/e/${r.endpointId}`} className="underline">
                        {r.resourceKey}
                      </Link>
                    </td>
                    <td
                      className={
                        r.decision.startsWith("refused_")
                          ? "font-semibold text-brand-deep"
                          : "text-brand"
                      }
                    >
                      {DECISION_LABEL[r.decision] ?? r.decision}
                    </td>
                    <td className="num">{formatUsdcUnits(r.amountUnits)}</td>
                    <td className="whitespace-nowrap text-brand-lift">
                      {r.txHash ? (
                        (() => {
                          const url = explorerTxUrl(r.network, r.txHash);
                          const short = `${r.txHash.slice(0, 10)}…${r.txHash.slice(-4)}`;
                          return url ? (
                            <a href={url} className="underline" rel="noopener noreferrer">
                              <code>{short}</code>
                            </a>
                          ) : (
                            <code title={r.txHash}>{short}</code>
                          );
                        })()
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Definitions</span>
        </h2>
        <p className="doc-p">{feed.definition}</p>
      </article>
    </main>
  );
}
