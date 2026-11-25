// ============================================================
// /erc-8004/agents/{chain}/{agentId} (2026-11-24 SEO proposal).
// Programmatic page per matched ERC-8004 agent. Facts only: the match rule, the payTo,
// purchase and settled counts, links to the payee page and the ledger. No score.
// Public English rules: no "we", no dashes as punctuation, no semicolons.
// ============================================================
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { SITE_URL } from "@/lib/site-url";
import { getErc8004MatchCached } from "@/lib/observatory/erc8004-match";
import {
  ERC8004_CHAIN_NAMES,
  ERC8004_CHAIN_SLUGS,
  agentPageIndexable,
  parseAgentIdParam,
  type Erc8004ChainSlug,
} from "@/lib/erc8004-pages/agents";
import { TableScroll } from "@/components/site/TableScroll";

type Props = { params: Promise<{ chain: string; agentId: string }> };

export const revalidate = 600;

async function load(params: Props["params"]) {
  const { chain, agentId: raw } = await params;
  if (!(chain in ERC8004_CHAIN_SLUGS)) return null;
  const slug = chain as Erc8004ChainSlug;
  const agentId = parseAgentIdParam(raw);
  if (!agentId) return null;
  const data = await getErc8004MatchCached();
  if (data.status !== "ok") return null;
  const rows = data.matches.filter((m) => m.chainId === ERC8004_CHAIN_SLUGS[slug] && m.agentId === agentId);
  if (rows.length === 0) return null;
  return { slug, agentId, rows, readAt: data.readAt };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = await load(params);
  if (!d) notFound();
  const chainName = ERC8004_CHAIN_NAMES[d.slug];
  const title = `ERC-8004 agent ${d.agentId} on ${chainName}: x402 purchase record`;
  return {
    ...pageMetadata({
      title,
      description: `ERC-8004 agent ${d.agentId} on ${chainName}: the payTo addresses vet402 paid over x402 that equal this agent's owner or agentWallet, with purchase and settled counts read at ${d.readAt.slice(0, 10)}.`,
      path: `/erc-8004/agents/${d.slug}/${d.agentId}`,
      noindex: !agentPageIndexable(d.rows),
    }),
    title: { absolute: `${title} | vet402` },
  };
}

export default async function Erc8004AgentPage({ params }: Props) {
  const d = await load(params);
  if (!d) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const chainName = ERC8004_CHAIN_NAMES[d.slug];
  const path = `/erc-8004/agents/${d.slug}/${d.agentId}`;
  const purchases = d.rows.reduce((a, r) => a + r.purchases, 0);
  const settled = d.rows.reduce((a, r) => a + r.settled, 0);

  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "ERC-8004", path: "/erc-8004" },
    { name: `Agent ${d.agentId} (${chainName})`, path },
  ]);
  const itemPage = {
    "@context": "https://schema.org",
    "@type": "ItemPage",
    name: `ERC-8004 agent ${d.agentId} on ${chainName}`,
    url: `${SITE_URL}${path}`,
    dateModified: d.readAt,
    isBasedOn: `${SITE_URL}/observatory/methodology#erc8004`,
    about: {
      "@type": "Thing",
      name: `ERC-8004 agent ${d.agentId}`,
      identifier: `${ERC8004_CHAIN_SLUGS[d.slug]}:${d.agentId}`,
    },
  };

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        {[itemPage, breadcrumb].map((doc, i) => (
          <script
            key={i}
            type="application/ld+json"
            nonce={nonce}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: safeJsonLd(doc) }}
          />
        ))}
        <h1 className="doc-title mt-8">
          ERC-8004 agent {d.agentId} on {chainName}
        </h1>
        <p className="doc-p">
          As of {d.readAt.slice(0, 10)} (UTC), vet402 made {purchases.toLocaleString("en-US")} x402 purchase attempts
          to addresses that equal this agent&apos;s owner or agentWallet. {settled.toLocaleString("en-US")} of them
          settled on-chain.
        </p>
        <TableScroll label={`payTo addresses matched to ERC-8004 agent ${d.agentId}`}>
          <table className="fact-table">
            <thead>
              <tr>
                <th scope="col">payTo</th>
                <th scope="col">Matched as</th>
                <th scope="col">Purchases</th>
                <th scope="col">Settled</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={`${r.payTo}-${r.matchKind}`}>
                  <td>
                    <Link href={`/payee/${r.payTo}`} className="doc-link" prefetch={false}>
                      <code>{r.payTo}</code>
                    </Link>
                  </td>
                  <td>{r.matchKind === "owner" ? "owner" : "agentWallet"}</td>
                  <td className="num">{r.purchases.toLocaleString("en-US")}</td>
                  <td className="num">{r.settled.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <p className="doc-p">
          A match is exact lowercase address equality between a payTo on a vet402 purchase row and the agent&apos;s
          owner or agentWallet in vet402&apos;s index of the Identity Registry. It shows that the seller was paid at an
          address the agent registered. It does not show that the agent operates the seller.{" "}
          <Link href="/observatory/methodology#erc8004" className="doc-link">
            Methodology
          </Link>
          {" · "}
          <Link href="/observatory/erc8004" className="doc-link">
            Matched agents table
          </Link>
          {" · "}
          <Link href="/erc-8004" className="doc-link">
            What is ERC-8004?
          </Link>
        </p>
        <p className="doc-p">
          Check this agent&apos;s feedback on Base with <code>GET /api/v1/erc8004/check?agentId={d.agentId}</code> or
          the MCP tool <code>check_8004_agent</code>.
        </p>
      </article>
    </main>
  );
}
