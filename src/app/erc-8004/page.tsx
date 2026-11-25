// ============================================================
// /erc-8004 pillar page (2026-11-24 SEO/AEO/LLMO proposal).
//
// WHY: /x402 is the pillar for the x402 query family. The ERC-8004 query family
// ("ERC-8004", "ERC-8004 registry", "what is ERC-8004") had no answer page on
// vet402.com: only /observatory/erc8004, a measurement table whose title does not
// answer the definitional query. This page answers the definition first in two
// sentences (AEO), then shows the one fact no explorer publishes: how many
// registered agents matched to a payTo vet402 paid, read from the same cached read as
// /observatory/erc8004 (no new query, no new number).
//
// Facts about the standard come from the EIP text (eips.ethereum.org/EIPS/eip-8004).
// Registry addresses are the ones already pinned in src/lib/chain/config.ts.
// Public English rules: no "we", no dashes as punctuation, no semicolons.
// ============================================================
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { ERC8004_INDEXED_CHAIN, getErc8004MatchCached } from "@/lib/observatory/erc8004-match";
import {
  ERC8004_OBSERVATORY_CHAINS,
  erc8004BaseTotals,
  erc8004HeadlineChainLabel,
  erc8004MatchedFraction,
} from "@/lib/observatory/erc8004-page";
import { TableScroll } from "@/components/site/TableScroll";

const PATH = "/erc-8004";
const PUBLISHED = "2026-11-24";

const PAGE_DESCRIPTION =
  "ERC-8004 is an Ethereum standard with three on-chain registries for AI agents: identity, reputation and validation. What each registry does, and how many registered agents have an owner or agentWallet that exactly matches a payTo vet402 paid over x402.";

export const metadata: Metadata = pageMetadata({
  title: "What is ERC-8004? Agent registries, with live payment data",
  description: PAGE_DESCRIPTION,
  path: PATH,
  ogType: "article",
  publishedTime: PUBLISHED,
});

export const revalidate = 600;

/** Definitional answers. Each answer stands alone so an answer engine can quote one. */
export const ERC8004_FAQ = [
  {
    question: "What is ERC-8004?",
    answer:
      "ERC-8004 (Trustless Agents) is an Ethereum standard that defines three registries for AI agents: an Identity Registry, a Reputation Registry and a Validation Registry. It lets agents be discovered and checked across organizations without a prior trust relationship.",
  },
  {
    question: "What does the ERC-8004 Identity Registry store?",
    answer:
      "The Identity Registry is an ERC-721 contract with URI storage. Each agent is a token: the agentId is the tokenId, and the agentURI points to a registration file that lists the agent's name, description and service endpoints such as A2A, MCP or a website.",
  },
  {
    question: "What does the ERC-8004 Reputation Registry store?",
    answer:
      "The Reputation Registry stores on-chain feedback signals that clients post about an agent: a value with decimals, optional tags, and revocation state. A feedbackURI may appear in the NewFeedback event for off-chain evidence but is not stored in contract state. The contract does not check that the client used or paid the agent, so raw feedback counts can be padded.",
  },
  {
    question: "What is the ERC-8004 Validation Registry?",
    answer:
      "The Validation Registry records independent checks of an agent's work, such as re-execution, zkML proofs or TEE attestations. The agent's owner or operator opens a validation request and names the validator, and the validator answers it.",
  },
  {
    question: "Does ERC-8004 handle payments?",
    answer:
      "No. Payments are out of scope for ERC-8004. The standard shows how an x402 payment proof can be attached to feedback, but payment itself happens over a separate protocol such as x402.",
  },
  {
    question: "How can I tell whether an ERC-8004 agent actually delivers?",
    answer:
      "A registration or a feedback count does not show delivery. vet402 pays x402 sellers with its own money and matches each payTo address to the owner or agentWallet of registered ERC-8004 agents, so the purchase record of a matched agent shows what came back on purchases to that address.",
  },
] as const;

/** Glossary terms on this page. Same strings feed the DefinedTermSet JSON-LD. */
const TERMS = [
  { term: "agentId", text: "The ERC-721 tokenId an Identity Registry assigns to an agent." },
  { term: "agentURI", text: "The URI that resolves to the agent's registration file, often ipfs, https or data." },
  { term: "agentWallet", text: "The wallet address an agent registers for receiving payments." },
  {
    term: "feedbackURI",
    text: "An optional link, carried in the NewFeedback event, to off-chain evidence such as an x402 proof of payment. It is not stored in Reputation Registry contract state.",
  },
  { term: "Validation request", text: "A request, opened by the agent's owner or operator, for a named validator to check the agent's work." },
] as const;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export default async function Erc8004PillarPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const match = await getErc8004MatchCached();
  const live = match.status === "ok";

  const article = articleJsonLd({
    headline: "What is ERC-8004? Agent registries, with live payment data",
    description: PAGE_DESCRIPTION,
    path: PATH,
    datePublished: PUBLISHED,
    dateModified: live ? match.readAt.slice(0, 10) : PUBLISHED,
  });
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: ERC8004_FAQ.map((q) => ({
      "@type": "Question",
      name: q.question,
      acceptedAnswer: { "@type": "Answer", text: q.answer },
    })),
  };
  const terms = {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    name: "ERC-8004 terms",
    url: `${SITE_URL}${PATH}#terms`,
    hasDefinedTerm: TERMS.map((t) => ({
      "@type": "DefinedTerm",
      name: t.term,
      description: t.text,
      inDefinedTermSet: `${SITE_URL}${PATH}#terms`,
    })),
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "ERC-8004", path: PATH },
  ]);

  const baseFrac = live ? erc8004MatchedFraction(ERC8004_INDEXED_CHAIN, match) : null;
  const baseTotals = live ? erc8004BaseTotals(match) : null;

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        {[article, faq, terms, breadcrumb].map((doc, i) => (
          <script
            key={i}
            type="application/ld+json"
            nonce={nonce}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: safeJsonLd(doc) }}
          />
        ))}

        <h1 className="doc-title mt-8">ERC-8004: agent registries, explained with live payment data</h1>
        <p className="doc-p">{ERC8004_FAQ[0].answer}</p>
        <p className="doc-p">
          A registration shows that an agent exists. It does not show that the agent delivers when it is paid. vet402
          pays x402 sellers itself and matches each recipient to registered agents, so this page can say how many
          registered agents have a purchase record.
        </p>

        <h2 className="sec-head mt-8">Registered agents whose address matches a payTo vet402 paid</h2>
        {live ? (
          <>
            <p className="doc-p">
              As of {match.readAt.slice(0, 10)} (UTC),{" "}
              {baseFrac && "fraction" in baseFrac ? (
                <>
                  {baseFrac.fraction} registered ERC-8004 agents on Base have an owner or agentWallet equal to a payTo
                  that vet402 paid over x402.
                </>
              ) : (
                <>Base match counts are unavailable ({baseFrac && "reason" in baseFrac ? baseFrac.reason : "unavailable"}).</>
              )}
              {baseTotals ? (
                <>
                  {" "}
                  Those recipients account for {fmt(baseTotals.matchedPurchases)} purchase rows, of which{" "}
                  {fmt(baseTotals.matchedSettled)} settled on-chain.
                </>
              ) : null}
            </p>
            <TableScroll label="Registered ERC-8004 agents matched to vet402 payTo, by chain">
              <table className="fact-table">
                <thead>
                  <tr>
                    <th scope="col">Chain</th>
                    <th scope="col">Registered agents scanned</th>
                    <th scope="col">Matched to a payTo vet402 paid</th>
                  </tr>
                </thead>
                <tbody>
                  {ERC8004_OBSERVATORY_CHAINS.map((chain) => {
                    const frac = erc8004MatchedFraction(chain, match);
                    return (
                      <tr key={chain}>
                        <td>{erc8004HeadlineChainLabel(chain)}</td>
                        {"unavailable" in frac ? (
                          <td colSpan={2}>Index not readable ({frac.reason})</td>
                        ) : (
                          <>
                            <td>{fmt(frac.scanned)}</td>
                            <td>{fmt(frac.matched)}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
            <p className="doc-p">
              Match rule, agent list and purchase counts:{" "}
              <Link href="/observatory/erc8004" className="doc-link">
                ERC-8004 agents matched to vet402 payTo addresses
              </Link>
              . A match is exact lowercase address equality. Names and endpoint URLs are not used.
            </p>
          </>
        ) : (
          <p className="doc-p">
            The index could not be read just now. The match table is at{" "}
            <Link href="/observatory/erc8004" className="doc-link">
              /observatory/erc8004
            </Link>
            .
          </p>
        )}

        <h2 className="sec-head mt-8">The three registries</h2>
        <p className="doc-p">
          ERC-8004 defines an Identity Registry, a Reputation Registry and a Validation Registry. The standard expects
          each registry to be deployed as a singleton per chain. vet402 reads agent identity on Base, Ethereum and BNB Chain for the match
          table above.
        </p>

        <h2 className="sec-head mt-8">Questions</h2>
        {ERC8004_FAQ.map((q) => (
          <section key={q.question}>
            <h3 className="doc-p font-medium mt-4">{q.question}</h3>
            <p className="doc-p">{q.answer}</p>
          </section>
        ))}

        <h2 className="sec-head mt-8" id="terms">
          Terms
        </h2>
        <dl>
          {TERMS.map((t) => (
            <div key={t.term}>
              <dt>
                <code>{t.term}</code>
              </dt>
              <dd className="doc-p">{t.text}</dd>
            </div>
          ))}
        </dl>

        <h2 className="sec-head mt-8">Check one agent</h2>
        <p className="doc-p">
          <code>GET /api/v1/erc8004/check</code> reads one Reputation Registry feedback on Base, fetches its feedbackURI,
          and re-reads the payment evidence on-chain. It needs no key. The same check is the MCP tool{" "}
          <code>check_8004_agent</code>.{" "}
          <Link href="/docs/api" className="doc-link">
            API reference
          </Link>
          .
        </p>

        <h2 className="sec-head mt-8">Sources</h2>
        <ul className="doc-p">
          <li>
            <a href="https://eips.ethereum.org/EIPS/eip-8004" className="doc-link">
              ERC-8004: Trustless Agents (EIP text)
            </a>
          </li>
          <li>
            <Link href="/observatory/methodology" className="doc-link">
              vet402 methodology
            </Link>
          </li>
          <li>
            <Link href="/x402" className="doc-link">
              What is x402?
            </Link>
          </li>
        </ul>
      </article>
    </main>
  );
}
