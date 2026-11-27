// ============================================================
// /x402/glossary (2026-11-24 SEO/AEO/LLMO proposal).
//
// WHY: protocol terms ("x402 facilitator", "payTo", "exact scheme", "Bazaar") are
// asked as single questions by answer engines. /observatory/methodology already
// defines vet402's own measurement words (L0, L1, delivered, inconclusive) as a
// DefinedTermSet. This page defines the protocol words, one anchor per term, and
// links measurement words to the methodology instead of copying them.
//
// Protocol definitions follow the x402 docs (docs.x402.org, Apache-2.0, source in
// github.com/x402-foundation/x402/tree/main/docs) and the ERC-8004 EIP text.
// Public English rules: no "we", no dashes as punctuation, no semicolons.
// ============================================================
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";

const PATH = "/x402/glossary";

export const metadata: Metadata = pageMetadata({
  title: "x402 and ERC-8004 glossary: facilitator, payTo, schemes",
  description:
    "Short definitions of x402 and ERC-8004 terms: HTTP 402, facilitator, payTo, PAYMENT-REQUIRED, exact, upto, batch settlement, Bazaar, CAIP-2, agentId and feedbackURI.",
  path: PATH,
  markdown: true,
});

export const revalidate = 86400;

type Term = { id: string; term: string; text: string; source: string };

export const GLOSSARY: readonly Term[] = [
  {
    id: "x402",
    term: "x402",
    text: "x402 is an open payment standard built on HTTP 402 Payment Required. It is network and token agnostic. A server answers 402 with payment terms, the client pays on the named network and asset (often USDC on many chains), and repeats the request with proof of payment.",
    source: "https://docs.x402.org/introduction",
  },
  {
    id: "http-402",
    term: "HTTP 402 Payment Required",
    text: "HTTP 402 Payment Required is a status code reserved for future use in the HTTP standard. x402 uses it to tell a client that a resource needs payment and to carry the amount, asset, network and recipient.",
    source: "https://docs.x402.org/core-concepts/http-402",
  },
  {
    id: "facilitator",
    term: "Facilitator",
    text: "An x402 facilitator is an optional service that verifies a buyer's payment payload and settles it on-chain for the seller, through /verify and /settle endpoints. It does not hold funds.",
    source: "https://docs.x402.org/core-concepts/facilitator",
  },
  {
    id: "payto",
    term: "payTo",
    text: "payTo is the recipient address in an x402 payment requirement. The buyer's payment goes to this address.",
    source: "https://docs.x402.org/core-concepts/client-server",
  },
  {
    id: "payment-required-header",
    term: "PAYMENT-REQUIRED header",
    text: "In x402 version 2, the 402 response carries the payment requirements in a Base64-encoded PAYMENT-REQUIRED header.",
    source: "https://docs.x402.org/core-concepts/facilitator",
  },
  {
    id: "payment-signature-header",
    term: "PAYMENT-SIGNATURE header",
    text: "In x402 version 2, the client repeats the request with a Base64-encoded payment payload in the PAYMENT-SIGNATURE header.",
    source: "https://docs.x402.org/core-concepts/facilitator",
  },
  {
    id: "exact",
    term: "exact scheme",
    text: "The exact scheme is a fixed-price x402 payment: the seller advertises one amount and the buyer signs for exactly that amount.",
    source: "https://docs.x402.org/schemes/exact",
  },
  {
    id: "upto",
    term: "upto scheme",
    text: "The upto scheme lets a seller advertise a maximum price for one request and settle for the amount actually used, at or below that maximum.",
    source: "https://docs.x402.org/schemes/upto",
  },
  {
    id: "batch-settlement",
    term: "batch-settlement scheme",
    text: "The batch-settlement scheme authorizes many requests with signed off-chain vouchers against an escrow deposit and redeems them on-chain later in batches.",
    source: "https://docs.x402.org/schemes/batch-settlement",
  },
  {
    id: "bazaar",
    term: "Bazaar",
    text: "The x402 Bazaar is a discovery extension: a machine-readable catalog of x402 endpoints and MCP tools with prices and schemas.",
    source: "https://docs.x402.org/extensions/bazaar",
  },
  {
    id: "caip-2",
    term: "CAIP-2 network id",
    text: "A CAIP-2 id names a chain in one string, for example eip155:8453 for Base. x402 version 2 uses it in the network field.",
    source: "https://chainagnostic.org/CAIPs/caip-2",
  },
  {
    id: "mpp",
    term: "MPP (Machine Payments Protocol)",
    text: "MPP is a separate HTTP payment protocol for machine clients. vet402 measures it on Tempo, where payments settle in USDC.e.",
    source: `${SITE_URL}/x402/chains/tempo`,
  },
  {
    id: "erc-8004",
    term: "ERC-8004",
    text: "ERC-8004 (Trustless Agents) is an Ethereum standard with three registries for AI agents: identity, reputation and validation. Payments are out of its scope.",
    source: "https://eips.ethereum.org/EIPS/eip-8004",
  },
  {
    id: "agentid",
    term: "agentId",
    text: "agentId is the ERC-721 tokenId the ERC-8004 Identity Registry assigns to an agent.",
    source: "https://eips.ethereum.org/EIPS/eip-8004",
  },
  {
    id: "agentwallet",
    term: "agentWallet",
    text: "agentWallet is the payment address an ERC-8004 agent registers. vet402 matches it, and the agent's owner address, against the payTo addresses it paid.",
    source: `${SITE_URL}/observatory/erc8004`,
  },
  {
    id: "feedbackuri",
    term: "feedbackURI",
    text: "feedbackURI is an optional link, carried in the NewFeedback event, from an ERC-8004 feedback entry to off-chain evidence, such as an x402 proof of payment. It is not stored in Reputation Registry contract state.",
    source: "https://eips.ethereum.org/EIPS/eip-8004",
  },
] as const;

export default async function GlossaryPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const setUrl = `${SITE_URL}${PATH}`;
  const termSet = {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": setUrl,
    name: "x402 and ERC-8004 glossary",
    url: setUrl,
    hasDefinedTerm: GLOSSARY.map((t) => ({
      "@type": "DefinedTerm",
      "@id": `${setUrl}#${t.id}`,
      name: t.term,
      description: t.text,
      url: `${setUrl}#${t.id}`,
      inDefinedTermSet: setUrl,
      sameAs: t.source,
    })),
  };
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: "Glossary", path: PATH },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        {[termSet, breadcrumb].map((doc, i) => (
          <script
            key={i}
            type="application/ld+json"
            nonce={nonce}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: safeJsonLd(doc) }}
          />
        ))}
        <h1 className="doc-title mt-8">x402 and ERC-8004 glossary</h1>
        <p className="doc-p">
          Protocol terms, one line each, with the primary source. Words vet402 uses for its own measurements (L0, L1,
          L2, delivered, inconclusive) are defined in the{" "}
          <Link href="/observatory/methodology" className="doc-link">
            methodology
          </Link>
          .
        </p>
        <dl className="space-y-6">
          {GLOSSARY.map((t) => (
            <div key={t.id} id={t.id}>
              <dt className="sec-head mt-8">{t.term}</dt>
              <dd className="doc-p">
                {t.text}{" "}
                <a href={t.source} className="doc-link">
                  Source
                </a>
              </dd>
            </div>
          ))}
        </dl>
        <p className="doc-p">
          Related:{" "}
          <Link href="/x402" className="doc-link">
            What is x402?
          </Link>{" "}
          ·{" "}
          <Link href="/erc-8004" className="doc-link">
            What is ERC-8004?
          </Link>{" "}
          ·{" "}
          <Link href="/x402/check-a-seller" className="doc-link">
            How a seller check works
          </Link>
        </p>
      </article>
    </main>
  );
}
