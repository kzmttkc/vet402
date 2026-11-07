import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { CREDENTIALS } from "@/lib/about/credentials";
import { fetchSdkDownloads } from "@/lib/about/npm-downloads";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

export const metadata: Metadata = pageMetadata({
  title: "About",
  description: "Who builds vet402, what it does, and the prizes and grants behind it.",
  path: "/about",
});

function observatoryLeadSentence(stats: Awaited<ReturnType<typeof getObservatoryStatsCached>> | null): string | null {
  if (!stats?.readAt) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(stats.readAt);
  if (!m) return null;
  const readDate = m[1];
  const settled = stats.l1.settled.toLocaleString("en-US");
  const delivered = stats.l1.delivered.toLocaleString("en-US");
  return `As of ${readDate}, ${settled} of its purchases had settled on-chain, and ${delivered} of them counted as delivered.`;
}

// 改訂日と名前は credentials.json が正（後で llms.txt・JSON-LD も同じ値から作る）。
function revisionDate(): Date {
  return new Date(`${CREDENTIALS.revision}T00:00:00Z`);
}
const revisionLong = revisionDate().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const revisionMonth = revisionDate().toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
const builder = CREDENTIALS.builder;

export default async function AboutPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "About", path: "/about" },
  ]);

  const [stats, downloads] = await Promise.all([
    getObservatoryStatsCached().catch(() => null),
    fetchSdkDownloads(),
  ]);
  const leadStats = observatoryLeadSentence(stats);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet space-y-8 text-[0.84375rem] text-brand">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Page: about</span>
            <span>
              Revision: <span className="text-signal">{revisionLong}</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>{revisionMonth}</span>
          </div>
        </div>
        <div>
          <h1 className="doc-title mt-8">About vet402</h1>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        </div>

        <p>
          vet402 buys from x402 sellers and publishes each result.
          {leadStats ? ` ${leadStats}` : ""} payOrRefuse, built on vet402, won a prize at ETHOnline 2026.
          vet402 was also selected for Circle&apos;s Arc Microgrants and for a Prezenti grant on Celo.
        </p>

        <section className="space-y-2">
          <h2 className="sec-head">Who builds vet402</h2>
          <p>
            I&apos;m {builder.builderName}, and I build vet402 on my own. Elsewhere I go by {builder.publicName}.
            The site is published by {builder.publisher}, my sole proprietorship in Japan.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">What vet402 does</h2>
          <p>
            An x402 payment proves that an agent paid. It does not show whether the seller delivered,
            so vet402 checks that by buying. I pay x402 sellers myself in stablecoins, check what each
            one sends back, and publish each purchase on the{" "}
            <Link href="/impact" className="doc-link">
              Impact page
            </Link>
            , including the ones that did not deliver. An agent can{" "}
            <Link href="/x402/check-a-seller" className="doc-link">
              look up a seller
            </Link>{" "}
            before it pays.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="sec-head">Track record</h2>
          <ul className="space-y-3">
            {CREDENTIALS.credentials.map((c) => (
              <li key={c.id} className="border-l border-hair pl-3">
                <p className="text-brand-deep">{c.title}</p>
                <p className="mt-1">
                  {c.detail}
                  {c.whenLabel ? ` ${c.whenLabel}.` : null}
                </p>
                <p className="mt-1">
                  {c.link ? (
                    <a className="doc-link" href={c.link.url} rel="noopener noreferrer">
                      {c.link.label}
                    </a>
                  ) : (
                    <span className="doc-note">Background</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Downloads</h2>
          {downloads ? (
            <p>
              The @vet402/sdk package was downloaded {downloads.downloads.toLocaleString("en-US")} times
              from npm between {downloads.start} and {downloads.end} (npm downloads API, read{" "}
              {downloads.readAt}).
            </p>
          ) : (
            <p>
              Download counts are on{" "}
              <a className="doc-link" href="https://www.npmjs.com/package/@vet402/sdk" rel="noopener noreferrer">
                npm
              </a>
              .
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Data and code</h2>
          <p>
            The measurements are open data under CC BY 4.0 and the code is MIT. Read the{" "}
            <Link href="/api/v1/observatory/state" className="doc-link">
              state API
            </Link>
            , the{" "}
            <Link href="/observatory/methodology" className="doc-link">
              methodology
            </Link>
            , or the{" "}
            <a className="doc-link" href="https://github.com/kzmttkc/vet402" rel="noopener noreferrer">
              code on GitHub
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Contact</h2>
          <p>
            Email{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            . On X,{" "}
            <a className="doc-link" href="https://x.com/vet402_com" rel="noopener noreferrer">
              @vet402_com
            </a>
            .
          </p>
        </section>

        <p>
          Operator details and the commercial-transactions disclosure are in the{" "}
          <Link href="/legal/notice" className="doc-link">
            Legal Notice
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
