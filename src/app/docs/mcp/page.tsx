import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import TrackView from "@/components/site/TrackView";
import CodeBlock from "@/components/docs/CodeBlock";
import DocsToc, { type TocItem } from "@/components/docs/DocsToc";
import { TableScroll } from "@/components/site/TableScroll";
import { WideColumn } from "@/components/site/WideColumn";
import { SITE_URL } from "@/lib/site-url";
import {
  DELIVERY_FEED_LICENSE,
  DELIVERY_FEED_LICENSE_URL,
  DELIVERY_FEED_METHOD_URL,
  DELIVERY_FEED_RATE_PER_MIN,
} from "@/lib/delivery/sellers-feed";
import {
  MCP_DOCS_CONNECT_CURSOR,
  MCP_DOCS_CONTACT,
  MCP_DOCS_DELIVERED_ONE_LINER,
  MCP_DOCS_FEED_FIELDS,
  MCP_DOCS_FEED_FILTERS,
  MCP_DOCS_FEED_INTRO,
  MCP_DOCS_FEED_STALENESS,
  MCP_DOCS_INTRO,
  MCP_DOCS_PRIVACY,
} from "@/lib/docs/mcp-page-text";
import { keylessPaymentProofPerMinute } from "@/lib/api/keyless-limits";
import {
  MCP_DEFAULT_PER_MIN,
  MCP_FIND_PER_MIN,
  MCP_RATE_LIMIT_CODE,
  MCP_SELLER_PER_MIN,
} from "@/lib/mcp/public-limits";
import { TOOL_TEXT } from "@/lib/mcp/text";
import { MCP_DOCS_TOOL_APPROVAL } from "@/lib/docs/mcp-try-in-chat";
import { MCP_CONNECT_STEPS, MCP_READ_ONLY_LINE, MCP_REFUSED_SECTION } from "@/lib/docs/mcp-first-prompts";
import { TryInChat } from "@/components/docs/TryInChat";
import { pageMetadata, breadcrumbJsonLd, webApiJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { buildMonth } from "@/lib/build-month";

const MCP_PAGE_TITLE = "x402 MCP server: check a seller before paying";
const MCP_DOCS_BLURB =
  "Streamable HTTP at https://vet402.com/mcp. Tool check_x402_seller reads what vet402 recorded when it paid an x402 listing. Keyless reads.";

export const metadata: Metadata = pageMetadata({
  title: MCP_PAGE_TITLE,
  description: MCP_DOCS_BLURB,
  path: "/docs/mcp",
});

const TOC: TocItem[] = [
  { href: "#connect", label: "Connect" },
  { href: "#try-in-chat", label: "Try in chat" },
  { href: "#tools", label: "Tools" },
  { href: "#feed", label: "Delivery feed" },
  { href: "#limits", label: "Limits" },
  { href: "#method", label: "Methodology" },
  { href: "#privacy", label: "Privacy" },
  { href: "#contact", label: "Contact" },
];

const FEED_FIELDS = MCP_DOCS_FEED_FIELDS;

export default async function McpDocsPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "API reference", path: "/docs/api" },
    { name: "Hosted MCP", path: "/docs/mcp" },
  ]);
  // 2026-10-31 SEO: the page carried only a BreadcrumbList. Same WebAPI shape as /docs/api, pointing at this page.
  // No documentation: the only reference is this page, which is already url.
  const webApi = webApiJsonLd({
    name: "vet402 hosted MCP server",
    description: MCP_DOCS_BLURB,
    path: "/docs/mcp",
    documentation: null,
  });

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="docs_mcp_view" />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(webApi) }}
      />

      <DocsToc items={TOC} />
      <WideColumn />
      <article className="sheet sheet-wide mt-6 space-y-10">
        <div>
          <div className="doc-head doc-head-compact">
            <div className="doc-head-col">
              <span>Hosted MCP</span>
              <span>Streamable HTTP</span>
              <span>
                Auth: <span className="text-signal">none</span>
              </span>
            </div>
            <div className="doc-head-col">
              <span>vet402</span>
              <span>x402 Economy</span>
              <span>{buildMonth()}</span>
            </div>
          </div>
          <h1 className="doc-title mt-8">{MCP_PAGE_TITLE}</h1>
          <p className="mx-auto mt-3 max-w-[62ch] text-center text-brand">{MCP_DOCS_INTRO}</p>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        </div>

        <section id="connect" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">Connect</h2>
          <p className="text-[0.84375rem] text-brand">
            Endpoint: <code className="text-brand-deep">https://vet402.com/mcp</code>. Primary tool:{" "}
            <code className="text-brand-deep">check_x402_seller</code> (same JSON as GET /api/v1/check).
          </p>
          <p className="text-[0.84375rem] text-brand">
            Cursor: add this object to <code className="text-brand-deep">.cursor/mcp.json</code>:
          </p>
          <CodeBlock label="Cursor mcp.json" code={MCP_DOCS_CONNECT_CURSOR} />
          <p className="text-[0.84375rem] text-brand">
            Claude Code:{" "}
            <code className="text-brand-deep">claude mcp add --transport http vet402 https://vet402.com/mcp</code>
          </p>
          <p className="text-[0.84375rem] text-brand">
            Claude Desktop and Claude.ai: open Settings, Connectors, add a custom connector with URL{" "}
            <code className="text-brand-deep">https://vet402.com/mcp</code>.
          </p>
          <p className="text-[0.84375rem] text-brand">
            Any MCP client that speaks Streamable HTTP can use the same URL.
          </p>
          <p className="text-[0.84375rem] text-brand">{MCP_READ_ONLY_LINE}</p>
          <ol className="list-decimal space-y-1 pl-5 text-[0.84375rem] text-brand">
            {MCP_CONNECT_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="text-[0.84375rem] text-brand">{MCP_DOCS_TOOL_APPROVAL}</p>
        </section>

        <section id="tool-refusal" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">If the client refuses the tool</h2>
          <p className="text-[0.84375rem] text-brand">{MCP_REFUSED_SECTION}</p>
        </section>

        <TryInChat />

        <section id="tools" className="scroll-mt-32 space-y-4">
          <h2 className="sec-head">Tools</h2>
          <p className="text-[0.84375rem] text-brand">
            Production <code className="text-brand-deep">tools/list</code> returns five read-only tools (and{" "}
            <code className="text-brand-deep">find_x402_sellers</code> when on). Titles and descriptions below come from the server catalog.
          </p>
          <p className="text-[0.84375rem] text-brand">
            The same <code className="text-brand-deep">check_x402_seller</code> answer is also available over key-less REST at{" "}
            <code className="text-brand-deep">GET /api/v1/check?url=</code> (see{" "}
            <a href="/docs/api" className="doc-link">
              /docs/api
            </a>
            ).
          </p>
          <p className="text-[0.84375rem] text-brand">
            check_x402_seller reads vet402 purchase records.{" "}
            <code className="text-brand-deep">GET /api/v1/diagnose</code> fetches the URL now and reads the 402 response.
          </p>
          {(
            [
              ["check_x402_seller", TOOL_TEXT.check_x402_seller],
              ["check_my_x402_endpoint", TOOL_TEXT.check_my_x402_endpoint],
              ["find_x402_sellers", TOOL_TEXT.find_x402_sellers],
              ["check_payment_proof", TOOL_TEXT.check_payment_proof],
              ["check_8004_agent", TOOL_TEXT.check_8004_agent],
              ["check_concordium_agent", TOOL_TEXT.check_concordium_agent],
              ["check_nearai_attestation", TOOL_TEXT.check_nearai_attestation],
            ] as const
          ).map(([name, meta]) => (
            <div key={name} className="space-y-2">
              <h3 className="sub-head">
                <code className="text-brand-deep">{name}</code>
              </h3>
              <p className="text-[0.84375rem] text-brand">
                <strong className="text-brand-deep">{meta.title}</strong>. {meta.description}
              </p>
            </div>
          ))}
          <CodeBlock
            label="Example check_x402_seller input"
            code={`{
  "url": "https://api.exa.ai/search",
  "method": "POST"
}`}
          />
          <CodeBlock
            label="Example check_x402_seller output (abbreviated)"
            code={`{
  "recommendation": "ALLOW",
  "delivery": { "delivered": 2, "paid_attempts": 3, "window_days": 30 },
  "l1_purchases": [{
    "attempted_at": "2026-10-01T12:00:00Z",
    "network": "eip155:8453",
    "status": "settled",
    "tx_hash": "0x0000000000000000000000000000000000000000000000000000000000000001",
    "explorer_url": "https://basescan.org/tx/0x0000…"
  }],
  "record_url": "https://vet402.com/observatory/e/00000000-0000-0000-0000-000000000001",
  "method_url": "${DELIVERY_FEED_METHOD_URL}"
}`}
          />
        </section>

        <section id="feed" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">Delivery feed</h2>
          <p className="text-[0.84375rem] text-brand">{MCP_DOCS_FEED_INTRO}</p>
          <p className="text-[0.84375rem] text-brand">{MCP_DOCS_FEED_STALENESS}</p>
          <TableScroll label="Delivery feed row fields">
            <table className="fact-table">
              <caption className="sr-only">Delivery feed columns</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {FEED_FIELDS.map((f) => (
                  <tr key={f.name}>
                    <td className="font-mono text-brand-deep">{f.name}</td>
                    <td className="text-brand">{f.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <p className="text-[0.84375rem] text-brand">
            License: {DELIVERY_FEED_LICENSE} (
            <Link href={DELIVERY_FEED_LICENSE_URL} className="doc-link">
              {DELIVERY_FEED_LICENSE_URL}
            </Link>
            ). {MCP_DOCS_FEED_FILTERS}
          </p>
          <CodeBlock
            label="Example curl"
            code={`curl -s '${SITE_URL}/api/v1/delivery/sellers.json?listed_in=bazaar&min_delivered=1'`}
          />
        </section>

        <section id="limits" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">Limits</h2>
          <p className="text-[0.84375rem] text-brand">
            MCP: {MCP_DEFAULT_PER_MIN} requests per minute per IP for most tools, {MCP_FIND_PER_MIN} per minute for{" "}
            <code className="text-brand-deep">find_x402_sellers</code>, and {MCP_SELLER_PER_MIN} per minute for{" "}
            <code className="text-brand-deep">check_my_x402_endpoint</code>.{" "}
            <code className="text-brand-deep">check_payment_proof</code> shares {keylessPaymentProofPerMinute()} requests a minute per IP with POST /api/v1/payment-proof.{" "}
            <code className="text-brand-deep">check_8004_agent</code> shares 30 requests a minute per IP with GET /api/v1/erc8004/check. The delivery feed allows{" "}
            {DELIVERY_FEED_RATE_PER_MIN} requests per minute per IP.
          </p>
          <p className="text-[0.84375rem] text-brand">
            When MCP returns HTTP 429, the JSON-RPC error code is {MCP_RATE_LIMIT_CODE} with message{" "}
            <code className="text-brand-deep">rate_limited</code>.
          </p>
        </section>

        <section id="method" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">Methodology</h2>
          <p className="text-[0.84375rem] text-brand">
            <Link href={DELIVERY_FEED_METHOD_URL} className="doc-link">
              {DELIVERY_FEED_METHOD_URL}
            </Link>{" "}
            defines the measurements. {MCP_DOCS_DELIVERED_ONE_LINER}
          </p>
        </section>

        <section id="privacy" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">Privacy</h2>
          <p className="text-[0.84375rem] text-brand">
            {MCP_DOCS_PRIVACY}{" "}
            <Link href="/legal/privacy" className="doc-link">
              /legal/privacy
            </Link>
            .
          </p>
        </section>

        <section id="contact" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">Contact</h2>
          <p className="text-[0.84375rem] text-brand">
            <a href={`mailto:${MCP_DOCS_CONTACT}`} className="doc-link">
              {MCP_DOCS_CONTACT}
            </a>
          </p>
        </section>

        <p className="text-[0.84375rem]">
          <Link href="/docs/api" className="doc-link">
            API reference
          </Link>
        </p>
      </article>
    </main>
  );
}
