import Link from "next/link";
import { TableScroll } from "@/components/site/TableScroll";
import type { Erc8004MatchRead } from "@/lib/observatory/erc8004-match";
import {
  ERC8004_OBSERVATORY_CHAINS,
  ERC8004_PAGE_MATCH_RULE,
  ERC8004_PAGE_NOT_COUNTED,
  erc8004BaseTotals,
  erc8004HeadlineChainLabel,
  erc8004KeylessCheckHref,
  erc8004MatchedFraction,
  shortErc8004Address,
} from "@/lib/observatory/erc8004-page";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";

export function Erc8004ObservatoryView({ data }: { data: Erc8004MatchRead }) {
  const baseTotals = erc8004BaseTotals(data);
  const readAt = data.readAt;

  return (
    <>
      <h1 className="doc-title mt-8">ERC-8004 agents matched to vet402 payTo addresses</h1>
      <p className="doc-p mt-4 text-brand">
        Read at <span className="text-signal">{readAt}</span>. These figures come from the same database
        read as the <code>erc8004</code> object in{" "}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/v1/observatory/state" className="doc-link">
          /api/v1/observatory/state
        </a>
        . They may refresh on a different clock when the CDN serves a cached API response.
      </p>

      {data.status === "unavailable" ? (
        <p className="doc-p mt-6 text-brand-lift">
          ERC-8004 match counts could not be read (<code>{data.reason}</code>). Reload in a minute.
        </p>
      ) : (
        <>
          <dl className="mt-6 grid gap-6 sm:grid-cols-3">
            {ERC8004_OBSERVATORY_CHAINS.map((chain) => {
              const frac = erc8004MatchedFraction(chain, data);
              return (
                <div key={chain}>
                  <dt className="text-brand-deep">{erc8004HeadlineChainLabel(chain)} registered agents</dt>
                  <dd className="num mt-1 text-xl font-semibold text-brand">
                    {"unavailable" in frac ? (
                      <span className="text-base font-normal text-brand-lift">
                        unavailable (<code>{frac.reason}</code>)
                      </span>
                    ) : (
                      frac.fraction
                    )}
                  </dd>
                  {"fraction" in frac ? (
                    <dd className="mt-1 text-sm text-brand-lift">
                      {frac.matched.toLocaleString("en-US")} matched of {frac.scanned.toLocaleString("en-US")} scanned
                    </dd>
                  ) : null}
                </div>
              );
            })}
          </dl>

          {baseTotals ? (
            <TableScroll label="Base purchase totals for matched payTo addresses" className="mt-8">
              <table className="fact-table">
                <caption className="sr-only">Base purchase totals for matched payTo addresses</caption>
                <thead>
                  <tr>
                    <th scope="col">Measurement</th>
                    <th scope="col" className="num">
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-brand">Distinct payTo addresses with a matched agent (Base totals)</td>
                    <td className="num">{baseTotals.matchedPayTo.toLocaleString("en-US")}</td>
                  </tr>
                  <tr>
                    <td className="text-brand">Purchase rows to those payTo addresses (each row once)</td>
                    <td className="num">{baseTotals.matchedPurchases.toLocaleString("en-US")}</td>
                  </tr>
                  <tr>
                    <td className="text-brand">Settled purchase rows to those payTo addresses</td>
                    <td className="num">{baseTotals.matchedSettled.toLocaleString("en-US")}</td>
                  </tr>
                </tbody>
              </table>
            </TableScroll>
          ) : null}

          <h2 className="sec-head mt-8">
            <span className="sec-no">1.</span>
            <span>Match rule</span>
          </h2>
          <p className="doc-p">{ERC8004_PAGE_MATCH_RULE}</p>
          <p className="doc-p">{ERC8004_PAGE_NOT_COUNTED}</p>

          <h2 className="sec-head mt-8">
            <span className="sec-no">2.</span>
            <span>Matched agents</span>
          </h2>
          <p className="doc-p">
            Up to 200 agents sorted by purchase count. Each purchase row counts once even when its payTo owns
            several agents.
          </p>
          {data.matches.length === 0 ? (
            <p className="doc-p text-brand-lift">No matched agents in this read.</p>
          ) : (
            <TableScroll label="ERC-8004 agents matched to vet402 payTo">
              <table className="fact-table">
                <caption className="sr-only">ERC-8004 agents matched to vet402 payTo</caption>
                <thead>
                  <tr>
                    <th scope="col">Agent id</th>
                    <th scope="col">Chain</th>
                    <th scope="col">payTo</th>
                    <th scope="col" className="num">
                      Purchases
                    </th>
                    <th scope="col" className="num">
                      Settled
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.matches.map((row) => {
                    const checkHref = erc8004KeylessCheckHref(row.chainId, row.agentId);
                    return (
                      <tr key={`${row.chainId}:${row.agentId}:${row.payTo}:${row.matchKind}`}>
                        <td className="text-brand font-mono text-sm">
                          {checkHref ? (
                            <a href={checkHref} className="doc-link">
                              {row.agentId}
                            </a>
                          ) : (
                            row.agentId
                          )}
                        </td>
                        <td className="text-brand">{erc8004HeadlineChainLabel(row.chainId)}</td>
                        <td className="font-mono text-sm" title={row.payTo}>
                          {shortErc8004Address(row.payTo)}
                        </td>
                        <td className="num">{row.purchases.toLocaleString("en-US")}</td>
                        <td className="num">{row.settled.toLocaleString("en-US")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          )}
        </>
      )}

      <p className="doc-p mt-8">
        <Link href="/observatory/methodology#erc8004" className="doc-link">
          Methodology
        </Link>
        {" · "}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/v1/observatory/state" className="doc-link">
          Raw JSON
        </a>{" "}
        (<code>erc8004</code>) ·{" "}
        <a href="https://creativecommons.org/licenses/by/4.0/" className="doc-link">
          CC BY 4.0
        </a>
      </p>
      <p className="doc-p text-[0.84375rem] text-brand-lift">
        This page reuses the shared ERC-8004 read for up to {PUBLIC_READ_REVALIDATE} seconds. The check links on Base
        agent ids call the keyless{" "}
        <a href="/docs/api" className="doc-link">
          ERC-8004 check API
        </a>{" "}
        with vet402&apos;s attest writer client when on-chain feedback exists from that writer.
      </p>
    </>
  );
}