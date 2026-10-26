import Link from "next/link";
import TrackedLink from "@/components/site/TrackedLink";
import { ShareRule } from "@/components/site/Figures";
import { TableScroll } from "@/components/site/TableScroll";
import { SUPPORTED_CHAINS } from "@/components/site/supported-chains-data";
import { buttonClass } from "@/components/ui/Button";
import { publicChainLabel } from "@/lib/observatory/chains";
import type { ObservatoryStats } from "@/lib/observatory/reader";

/**
 * The two sections directly under the first screen of the front page (2026-10-21 owner decision,
 * option A: the first screen stays as it is, the ledger and the chain table sit under it).
 *
 * Every number comes from the one `getObservatoryStatsCached()` read the page already makes
 * (the same reader `/api/v1/observatory/state` and `/observatory/state` call). Nothing is
 * written into the source. When that read is not usable (`homeLedgerOf` returns null), neither
 * section is drawn: no zeros, no placeholder.
 */

/** The cached read, with the time the database was read (set when the cache entry was filled). */
export type HomeLedgerStats = ObservatoryStats & { readAt?: string };

export type HomeLedger = {
  /** UTC date of the database read, YYYY-MM-DD. The one cyan text on the section. */
  readDate: string;
  /** HH:MM UTC of the same read. */
  readTime: string;
  attempts: number;
  settled: number;
  delivered: number;
  activeEndpoints: number;
  passActive: number;
  /** Active listings whose latest verdict is fail or unverified. */
  notPassActive: number;
  /** l1.byChain rows with at least one settled purchase, in the reader's order. */
  chains: { chain: string; label: string; asset: string; settled: number; delivered: number; inconclusiveSettled: number }[];
};

/**
 * Settlement asset per public chain name. Lane rows in supported-chains-data.ts win, including
 * when the join key (stellar:pubnet, BSC, Arbitrum) differs from the public name. The methodology
 * sentence in src/lib/observatory/vocabulary.ts stays as a fallback for a name the lanes do not
 * list. tests/home-ledger.test.ts pins both sources. A chain named in neither prints "not named".
 */
const ASSET_FROM_METHODOLOGY: Record<string, string> = {
  Stellar: "USDC",
  "BNB Chain": "USD1",
  "Arbitrum One": "USDC",
  "Avalanche C-Chain": "USDC",
};
export const NO_ASSET = "not named";

export function settlementAssetOf(label: string): string {
  const name = publicChainLabel(label);
  for (const row of SUPPORTED_CHAINS) {
    if (row.kind === "lane" && (row.chain === name || row.chain === label || publicChainLabel(row.chain) === name)) {
      return row.asset;
    }
  }
  return ASSET_FROM_METHODOLOGY[name] ?? ASSET_FROM_METHODOLOGY[label] ?? NO_ASSET;
}

function stamp(iso: string | undefined): { date: string; time: string } | null {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? { date: m[1], time: m[2] } : null;
}

/**
 * Folds the cached read into what the two sections print, or null when it is not usable:
 * the read failed, the reader returned its empty shape (no database, totalEndpoints 0), the L1
 * ledger was not read (byChain empty, the same rule as settledByChainOf), or the cache entry
 * carries no read time (an entry filled before readAt existed).
 */
export function homeLedgerOf(stats: HomeLedgerStats | null | undefined): HomeLedger | null {
  if (!stats || stats.totalEndpoints <= 0 || stats.activeEndpoints <= 0) return null;
  const byChain = stats.l1?.byChain;
  if (!Array.isArray(byChain) || byChain.length === 0) return null;
  const read = stamp(stats.readAt);
  if (!read) return null;
  return {
    readDate: read.date,
    readTime: read.time,
    attempts: stats.l1.attempts,
    settled: stats.l1.settled,
    delivered: stats.l1.delivered,
    activeEndpoints: stats.activeEndpoints,
    passActive: stats.publishedPassActive,
    notPassActive: Math.max(0, stats.activeEndpoints - stats.publishedPassActive),
    chains: byChain
      .filter((r) => r.settled > 0)
      .map((r) => {
        const label = r.label || publicChainLabel(r.chain);
        return {
          chain: r.chain,
          label,
          asset: settlementAssetOf(label),
          settled: r.settled,
          delivered: r.delivered,
          inconclusiveSettled: typeof r.inconclusiveSettled === "number" ? r.inconclusiveSettled : 0,
        };
      }),
  };
}

const fmt = (n: number) => n.toLocaleString("en-US");

const NUM = "font-[family-name:var(--font-display)] font-semibold tabular-nums text-brand-deep";

export function LedgerSection({ ledger }: { ledger: HomeLedger }) {
  return (
    <section aria-labelledby="ledger">
      <h2 id="ledger" className="sec-head scroll-mt-24">
        <span>The public ledger</span>
      </h2>
      <p className="doc-note mt-4">
        Whole ledger, read <span className="text-signal">{ledger.readDate}</span> at {ledger.readTime} UTC
      </p>
      <div className="mt-3 grid gap-6 min-[800px]:grid-cols-2 min-[800px]:gap-x-6">
        <div className="border-t border-brand-deep pt-3">
          <p className="doc-caption">Paid attempts that settled</p>
          <p className="mt-2 text-[1.75rem] leading-[1.2]">
            <span className={NUM}>{fmt(ledger.settled)}</span>
            <span className="text-[0.9375rem] text-brand"> of {fmt(ledger.attempts)}</span>
          </p>
          <p className="mt-1 text-[0.84375rem] text-brand">
            {fmt(ledger.delivered)} of the settled purchases also returned a 2xx answer.
          </p>
        </div>
        <div className="border-t border-brand-deep pt-3">
          <p className="doc-caption">Latest L0 verdict on listed endpoints</p>
          <p className="mt-2 text-[1.75rem] leading-[1.2]">
            <span className={NUM}>{fmt(ledger.passActive)}</span>
            <span className="text-[0.9375rem] text-brand"> pass of {fmt(ledger.activeEndpoints)} listed</span>
          </p>
          <p className="mt-1 text-[0.84375rem] text-brand">
            {fmt(ledger.notPassActive)} listed endpoints do not have pass as their latest probe. That includes a published fail, unverified, and endpoints not yet probed.
          </p>
        </div>
      </div>
      <p className="doc-note mt-3">
        Customer count and revenue: not published. Source:{" "}
        {/* JSON の API であって頁ではない（クライアント遷移・prefetch させない）。demo/page.tsx と同じ理由で無効化する。 */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/v1/observatory/state" className="doc-link">
          /api/v1/observatory/state
        </a>{" "}
        (CC BY 4.0).
      </p>
      <p className="mt-6 flex flex-wrap gap-2 sm:gap-4">
        <TrackedLink
          href="/observatory"
          event="lp_cta_click"
          props={{ position: "ledger_observatory" }}
          className={buttonClass({ variant: "secondary", size: "md", className: "w-full max-sm:py-2.5 sm:w-auto" })}
        >
          Open the observatory
        </TrackedLink>
        <TrackedLink
          href="/observatory/state"
          event="lp_cta_click"
          props={{ position: "ledger_state" }}
          className={buttonClass({ variant: "secondary", size: "md", className: "w-full max-sm:py-2.5 sm:w-auto" })}
        >
          See both counts
        </TrackedLink>
      </p>
    </section>
  );
}

/**
 * "Where purchases settled". It replaces the memo's former section 5 "Chains" and keeps its anchor
 * (`#chains`), so a link to vet402.com/#chains still lands on the chains. The Robinhood Chain row
 * of that section is not a purchase lane and has no count, so it is printed under the table with
 * its agreed sentence (supported-chains-data.ts, 2026-09-28), unchanged, link included.
 */
export function SettledChainsSection({ ledger }: { ledger: HomeLedger }) {
  // 件数の行が無くても見出し（#chains）と Robinhood Chain の合意文は出す（点検 低: #chains の着地と /rwa への道を残す）。
  const products = SUPPORTED_CHAINS.filter((row) => row.kind === "product");
  return (
    <section aria-labelledby="chains">
      <h2 id="chains" className="sec-head scroll-mt-24">
        <span>Where purchases settled</span>
      </h2>
      <p className="doc-p">
        One row per chain with a settled purchase in the public ledger.{" "}
        <Link href="/observatory/state" className="doc-link">
          L1 figures by chain
        </Link>
        .
      </p>
      <TableScroll label="Settled purchases by chain" className="mt-6">
        {ledger.chains.length > 0 ? (
        <table className="fact-table">
          <caption className="sr-only">Settled purchases by chain</caption>
          <thead>
            <tr>
              <th scope="col">Chain</th>
              <th scope="col">Asset</th>
              <th scope="col" className="num">
                Settled purchases
              </th>
              <th scope="col" className="num">
                Answered 2xx
              </th>
              <th scope="col" className="num">
                Paid, no 2xx
              </th>
            </tr>
          </thead>
          <tbody>
            {ledger.chains.map((r) => (
              <tr key={r.chain}>
                <td title={r.chain}>
                  <span className="block">{r.label}</span>
                  <ShareRule
                    id={`chain-${r.chain.replace(/[^a-zA-Z0-9]+/g, "-")}`}
                    part={r.delivered}
                    whole={r.settled}
                    label={`${fmt(r.delivered)} of ${fmt(r.settled)} settled on ${r.label} answered 2xx`}
                  />
                </td>
                <td>{r.asset}</td>
                <td className="num">{fmt(r.settled)}</td>
                <td className="num">{fmt(r.delivered)}</td>
                <td className="num">{fmt(Math.max(0, r.settled - r.delivered))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        ) : null}
      </TableScroll>
      {products.map((row) =>
        row.kind === "product" ? (
          <p key={row.chain} className="doc-note mt-3">
            {row.chain}:{" "}
            {row.body.map((part, i) =>
              typeof part === "string" ? (
                <span key={i}>{part}</span>
              ) : part.href ? (
                <Link key={i} href={part.href} className="doc-link">
                  <code className="text-brand-deep">{part.code}</code>
                </Link>
              ) : (
                <code key={i} className="text-brand-deep">
                  {part.code}
                </code>
              ),
            )}
          </p>
        ) : null,
      )}
    </section>
  );
}
