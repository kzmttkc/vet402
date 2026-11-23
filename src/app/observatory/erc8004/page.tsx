import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { WideColumn } from "@/components/site/WideColumn";
import { Erc8004ObservatoryView } from "@/components/observatory/Erc8004ObservatoryView";
import { getErc8004MatchCached } from "@/lib/observatory/erc8004-match";

export const metadata: Metadata = pageMetadata({
  title: "ERC-8004 agents matched to vet402 payTo addresses",
  description:
    "Registered ERC-8004 Identity Registry agents on Base, Ethereum, and BNB Chain whose owner or agentWallet exactly matches a payTo vet402 paid, with purchase and settled counts.",
  path: "/observatory/erc8004",
});

export const revalidate = 600;

export default async function ObservatoryErc8004Page() {
  const data = await getErc8004MatchCached();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Observatory", path: "/observatory" },
    { name: "ERC-8004 match", path: "/observatory/erc8004" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet sheet-wide">
        <WideColumn />
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Report: ERC-8004 address match</span>
            <span className="doc-asof">
              Index read at <span className="text-signal">{data.readAt}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>
              <Link href="/observatory/state" className="underline">
                State of x402
              </Link>
              {" · "}
              <Link href="/observatory/methodology#erc8004" className="underline">
                Methodology
              </Link>
            </span>
            <span>
              <Link href="/observatory" className="underline">
                Full register
              </Link>
            </span>
          </div>
        </div>

        <Erc8004ObservatoryView data={data} />
      </article>
    </main>
  );
}