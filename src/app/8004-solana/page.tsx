import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { WideColumn } from "@/components/site/WideColumn";
import { TableScroll } from "@/components/site/TableScroll";
import { breadcrumbJsonLd, datasetJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { getErc8004MatchCached } from "@/lib/observatory/erc8004-match";
import {
  ERC8004_SOLANA_INDEXER_ORIGIN,
  ERC8004_SOLANA_PAGE_PATH,
  ERC8004_SOLANA_PROGRAM_ID,
} from "@/lib/observatory/erc8004-solana-constants";
import {
  ERC8004_SOLANA_MATCH_RULE,
  ERC8004_SOLANA_NOT_COUNTED,
} from "@/lib/observatory/erc8004-solana-page";
import { ladderCount, readErc8004SolanaLadder } from "@/lib/observatory/erc8004-solana-ladder";

const PATH = ERC8004_SOLANA_PAGE_PATH;

export const metadata: Metadata = pageMetadata({
  title: "8004-solana registry overlap with vet402 Solana purchases",
  description:
    "Registered 8004-solana agents on Solana mainnet, x402 declarations in the public index, and how many match a payTo vet402 paid with exact base58 address equality.",
  path: PATH,
  ogType: "article",
  publishedTime: "2026-11-26",
});

export const revalidate = 600;

export default async function Erc8004SolanaPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const match = await getErc8004MatchCached();
  const ladder = await readErc8004SolanaLadder(match);
  const readAt = ladder.readAt;

  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "What is ERC-8004?", path: "/erc-8004" },
    { name: "8004-solana", path: PATH },
  ]);

  const dataset = datasetJsonLd({
    name: "8004-solana ladder counts",
    description:
      "Counts of registered 8004-solana agents, x402 declarations, address matches to vet402 payTo, and purchase outcomes on Solana mainnet.",
    path: PATH,
    citeUrl: `${SITE_URL}/api/v1/observatory/state`,
    measurementTechnique:
      "The index job reads the public 8004-solana indexer into vet402's database, then exact base58 equality between Solana purchase payTo and indexed owner or agentWallet. Delivery uses vet402 L1 rules on matched payTo rows.",
    variableMeasured: [
      "registered agents indexed",
      "x402Support declarations (indexer stats)",
      "agents matched by payTo address",
      "purchase attempts to matched payTo",
      "settled purchases",
      "delivered HTTP responses",
    ],
    keywords: ["8004-solana", "ERC-8004", "Solana", "x402", "agent registry"],
    retrievedAt: readAt.slice(0, 10),
    distribution: [
      {
        name: "vet402 Solana payTo sample",
        encodingFormat: "text/csv",
        contentUrl: `${SITE_URL}/data/8004-solana-vet402-payto.csv`,
      },
      {
        name: "Agent hostname overlap (domain method, not address match)",
        encodingFormat: "text/csv",
        contentUrl: `${SITE_URL}/data/8004-solana-agents-hosts.csv`,
      },
    ],
  });

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet sheet-wide">
        <WideColumn />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(dataset) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>8004-solana on Solana mainnet</span>
            <span className="doc-asof">
              Read at <span className="text-signal">{readAt}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory/erc8004" className="underline">
                ERC-8004 match
              </Link>
              {" · "}
              <Link href="/erc-8004" className="underline">
                What is ERC-8004?
              </Link>
            </span>
          </div>
        </div>

        <h1 className="doc-title mt-8">8004-solana: registry to vet402 purchase overlap</h1>
        <p className="doc-p mt-4 text-brand">
          Four steps count how the public 8004-solana index on Solana mainnet lines up with vet402&apos;s own Solana
          purchase rows. Figures refresh from vet402&apos;s database and the indexed snapshot. They exclude hostname
          overlap and seller names.
        </p>

        <TableScroll label="8004-solana ladder" className="mt-8">
          <table className="fact-table">
            <caption className="sr-only">8004-solana measurement ladder</caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col" className="num">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-brand">1. Registered agents in vet402&apos;s 8004-solana index</td>
                <td className="num">{ladderCount(ladder.registered)}</td>
              </tr>
              <tr>
                <td className="text-brand">2. Agents with x402Support declared (indexer stats snapshot)</td>
                <td className="num">{ladderCount(ladder.x402Declared)}</td>
              </tr>
              <tr>
                <td className="text-brand">3. Agents whose owner or agentWallet equals a vet402 Solana payTo</td>
                <td className="num">{ladderCount(ladder.matchedAgents)}</td>
              </tr>
              <tr>
                <td className="text-brand">4. Purchase attempts to matched payTo addresses</td>
                <td className="num">{ladderCount(ladder.purchaseAttempts)}</td>
              </tr>
              <tr>
                <td className="text-brand">Settled on-chain among those attempts</td>
                <td className="num">{ladderCount(ladder.settled)}</td>
              </tr>
              <tr>
                <td className="text-brand">Delivered HTTP responses among settled rows</td>
                <td className="num">{ladderCount(ladder.delivered)}</td>
              </tr>
            </tbody>
          </table>
        </TableScroll>

        {ladder.indexSlot ? (
          <p className="doc-p text-brand-lift">
            Last indexed slot from the index job: <code>{ladder.indexSlot}</code>.
          </p>
        ) : null}

        <h2 className="sec-head mt-8">
          <span className="sec-no">1.</span>
          <span>Method</span>
        </h2>
        <p className="doc-p">{ERC8004_SOLANA_MATCH_RULE}</p>
        <p className="doc-p">{ERC8004_SOLANA_NOT_COUNTED}</p>
        <p className="doc-p">
          The scheduled index job reads{" "}
          <a href={ERC8004_SOLANA_INDEXER_ORIGIN} className="doc-link">
            {ERC8004_SOLANA_INDEXER_ORIGIN}
          </a>{" "}
          once per day at most one request per second. Program id{" "}
          <code>{ERC8004_SOLANA_PROGRAM_ID}</code>. Registration files are not fully mirrored: many URIs fail or rate
          limit, so domain overlap is a lower bound only and is not shown here.
        </p>
        <p className="doc-p">
          Delivery counts follow vet402&apos;s L1 definition: settled on-chain, then an HTTP 2xx other than 202 with a
          non-empty body. The table states how many matched payTo addresses vet402 reached in aggregate. It does not
          name any agent.
        </p>

        <h2 className="sec-head mt-8">
          <span className="sec-no">2.</span>
          <span>Open data</span>
        </h2>
        <ul className="doc-ul">
          <li>
            <a href="/data/8004-solana-vet402-payto.csv" className="doc-link">
              vet402 Solana payTo sample CSV
            </a>
          </li>
          <li>
            <a href="/data/8004-solana-agents-hosts.csv" className="doc-link">
              Agent host overlap CSV (domain method, not used in the address match)
            </a>
          </li>
          <li>
            <a href="/api/v1/observatory/state" className="doc-link">
              Observatory state JSON
            </a>{" "}
            (<code>erc8004.byChain</code>)
          </li>
        </ul>

        <p className="doc-p mt-8">
          <Link href="/observatory/methodology#erc8004" className="doc-link">
            Methodology
          </Link>
          {" · "}
          <Link href="/observatory/erc8004" className="doc-link">
            ERC-8004 match table
          </Link>
        </p>
      </article>
    </main>
  );
}