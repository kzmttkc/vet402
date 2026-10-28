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
  MCP_DOCS_INTRO,
  MCP_DOCS_PRIVACY,
} from "@/lib/docs/mcp-page-text";
import {
  MCP_DEFAULT_PER_MIN,
  MCP_FIND_PER_MIN,
  MCP_RATE_LIMIT_CODE,
  MCP_SELLER_PER_MIN,
} from "@/lib/mcp/public-limits";
import { TOOL_TEXT } from "@/lib/mcp/text";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { buildMonth } from "@/lib/build-month";

export const metadata: Metadata = pageMetadata({
  title: "Hosted MCP server",
  description:
    "Streamable HTTP MCP at https://vet402.com/mcp and the delivery feed at /api/v1/delivery/sellers.json. Keyless reads.",
  path: "/docs/mcp",
});

const TOC: TocItem[] = [
  { href: "#connect", label: "Connect" },
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

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="docs_mcp_view" />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
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
          <h1 className="doc-title mt-8">Hosted MCP server</h1>
          <p className="mx-auto mt-3 max-w-[62ch] text-center text-brand">{MCP_DOCS_INTRO}</p>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        </div>

        <section id="connect" className="scroll-mt-32 space-y-3">
          <h2 className="sec-head">Connect</h2>
          <p className="text-[0.84375rem] text-brand">
            Cursor: add this object to <code className="text-brand-deep">.cursor/mcp.json</code>:
          </p>
          <CodeBlock label="Cursor mcp.json" code={MCP_DOCS_CONNECT_CURSOR} />
          <p className="text-[0.84375rem] text-brand">
            Claude Code:{" "}
            <code className="text-brand-deep">claude mcp add --transport http vet402 https://vet402.com/mcp</code>
          </p>
          <p className="text-[0.84375rem] text-brand">
            Claude.ai: open Settings, Connectors, add a custom connector with URL{" "}
            <code className="text-brand-deep">https://vet402.com/mcp</code>.
          </p>
          <p className="text-[0.84375rem] text-brand">
            Any MCP client that speaks Streamable HTTP can use the same URL.
          </p>
        </section>

        <section id="tools" className="scroll-mt-32 space-y-4">
          <h2 className="sec-head">Tools</h2>
          <p className="text-[0.84375rem] text-brand">
            Production <code className="text-brand-deep">tools/list</code> returns three read-only tools. Titles and descriptions below come from the server catalog.
          </p>
          {(
            [
              ["check_x402_seller", TOOL_TEXT.check_x402_seller],
              ["check_my_x402_endpoint", TOOL_TEXT.check_my_x402_endpoint],
              ["find_x402_sellers", TOOL_TEXT.find_x402_sellers],
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
  "url": "https://api.example.com/v1/data",
  "method": "GET"
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
            <code className="text-brand-deep">check_my_x402_endpoint</code>. The delivery feed allows {DELIVERY_FEED_RATE_PER_MIN} requests per minute per IP.
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
