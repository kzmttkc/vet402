import { headers } from "next/headers";
import Link from "next/link";
import { Inter } from "next/font/google";
import { fragmentMono, martianMono } from "./fonts";
import TrackView from "@/components/site/TrackView";
import TrackedLink from "@/components/site/TrackedLink";
import OutboundAnchor from "@/components/site/OutboundAnchor";
import { HomeLivenessNote } from "@/components/site/StatusBanner";
import { BILLING_PLANS, isStripeConfigured } from "@/lib/billing/plans";
import { SITE_URL } from "@/lib/site-url";
import { isPublicExplorerTxUrl } from "@/lib/observatory/chains";
import { organizationJsonLd, pageMetadata, publisherOrg } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { homeLedgerOf } from "@/components/site/HomeLedger";
import { getHomeExampleCached, cardDeliveredLabel, fmt, sellerRecordParts, utc } from "@/lib/observatory/home-example";
import s from "./home.module.css";

export const metadata = pageMetadata({
  title: "vet402: verify x402 payments for AI agents",
  description:
    "vet402 checks an x402 seller before your AI agent pays, caps spending, and publishes what each seller delivered. Settlement assets include USDC.",
  path: "/",
});

/* vet402 front page, DIRECTION CONTRACT (2026-11-08, owner 11/07 23:41 and 23:49)

   THESIS   The safety layer between agents that pay and APIs that get paid, said in one
            line, then proved with one real purchase. Refuses the old memo-as-front-page
            and the SaaS card grid.
   WORLD    Neutral greys only (R = G = B). Light: white, #000 and #333 ink, #f7f7f7 and
            #dedede hairlines. Dark: #090909, four greys, white rules at low alpha. Inter for
            words, Fragment Mono only for hosts, transactions and table numbers.
   STORY    What it is, that it is real (a purchase card and counts with a read time), what
            goes wrong, where it sits, what is live and what is coming, then the open data.
   FIRST    Headline, one sentence, two ways in (buyer, seller). Right: the latest real
   VIEWPORT purchase as a record. Under both: four counts from the state read and its time.
   SOURCE   .company/WORK_ORDERS.md "LP の見た目を一新する" in the operator repo. The full
            previous front page lives at /memo, unchanged. */

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/** The first settled purchase in the public export (export.csv?days=365, read 2026-11-08). A past fact, so it is fixed. */
const FIRST_SETTLED_AT = "2026-08-14T09:54:33Z";

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.floor((b - a) / 86_400_000);
}

const ENTRY_CARDS = [
  {
    title: "Before you pay",
    sentence: "Check what a seller delivered before an agent signs.",
    href: "/x402/check-a-seller",
    event: "entry_before_pay" as const,
    linkLabel: "Check a seller",
  },
  {
    title: "While you pay",
    sentence: "The spend guard in @vet402/sdk caps each payment and refuses when a rule fails.",
    // 2026-11-10: #quickstart は判定 API の curl の手順で、spend guard の説明は #packages にある。
    href: "/docs/api#packages",
    event: "entry_while_pay" as const,
    linkLabel: "Spend guard in the SDK",
  },
  {
    title: "After you pay",
    sentence: "Public records list each purchase with its transaction and what came back.",
    href: "/observatory",
    event: "entry_after_pay" as const,
    linkLabel: "Observatory",
  },
] as const;

const FOOT_PRODUCT = [
  { label: "Docs", href: "/docs/api" },
  { label: "MCP", href: "/docs/mcp" },
  { label: "Get an API key", href: "/signup" },
  { label: "Dashboard", href: "/dashboard" },
] as const;

const FOOT_X402 = [
  { label: "What is x402", href: "/x402" },
  { label: "Check a seller", href: "/x402/check-a-seller" },
  { label: "Observatory", href: "/observatory" },
  { label: "Sellers", href: "/sellers" },
  { label: "x402 by chain", href: "/x402/chains" },
  { label: "Stablecoin payments", href: "/x402/stablecoin-payments" },
  { label: "State of x402", href: "/observatory/state" },
  { label: "Methodology", href: "/observatory/methodology" },
] as const;

const FOOT_RECORD = [
  { label: "About", href: "/about" },
  { label: "FAQ", href: "/faq" },
  { label: "Blog", href: "/blog" },
  { label: "Status", href: "/status" },
  { label: "Corrections", href: "/corrections" },
  { label: "The memo", href: "/memo" },
  { label: "GitHub", href: "https://github.com/kzmttkc/vet402" },
  { label: "X", href: "https://x.com/vet402_com" },
] as const;

const FOOT_LEGAL = [
  { label: "Terms", href: "/legal/terms" },
  { label: "Privacy", href: "/legal/privacy" },
  { label: "Legal notice", href: "/legal/notice" },
] as const;

export default async function Home() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const [stats, example] = await Promise.all([
    getObservatoryStatsCached().catch(() => null),
    getHomeExampleCached().catch(() => null),
  ]);
  const ledger = homeLedgerOf(stats);
  const readAt = stats?.readAt ?? null;
  const days = readAt ? daysBetween(FIRST_SETTLED_AT, readAt) : null;
  const notDelivered = ledger ? Math.max(0, ledger.settled - ledger.delivered) : 0;
  const receipt = example?.receipt ?? null;
  const decision = example?.decision ?? null;
  const sellerLine = decision
    ? sellerRecordParts(decision.l1.delivered, decision.l1.attempts, decision.l1.windowDays)
    : null;
  const organization = organizationJsonLd(
    "Independent verification of the x402 agent-payment economy. vet402 buys from x402 endpoints, re-reads each payment on-chain, records what came back, checks it against the seller's output declaration when there is one, and publishes the results. The records cover x402 payments for AI agents, including USDC where that is the pinned asset.",
  );
  // 2026-08-14 SEO/AEO: WebSite ノードが欠けていた（Organization と
  // SoftwareApplication はあった）。検索の sitelinks／エンティティ束ねに効く
  // 基本ノードで、publisher で Organization に結ぶ。site 内検索は無いので
  // potentialAction(SearchAction) は書かない（存在しない導線を主張しない）。
  const webSiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "vet402",
    url: SITE_URL,
    description: "Independent verification of x402 payments for AI agents.",
    publisher: publisherOrg(),
    inLanguage: "en",
    sameAs: organization.sameAs,
  };
  const softwareApplicationJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "vet402",
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    description: String(metadata.description),
    // An Offer is a machine-readable assertion that a plan is purchasable at
    // this price — read by search engines and by the buying agents this product
    // exists to serve. The paid entries are therefore tied to whether checkout
    // can actually complete, the same `isStripeConfigured()` that gates the
    // billing API and the paid CTA. On 2026-09-01 production advertised Pro and
    // Scale while its checkout handed customers a TEST-mode Stripe page; the
    // plan table below stays (it describes the tiers, which exist) but the
    // purchase claim does not outlive the ability to honour it.
    offers: [
      {
        "@type": "Offer",
        name: BILLING_PLANS.free.name,
        price: "0",
        priceCurrency: "USD",
        description: `${BILLING_PLANS.free.monthlyLimit.toLocaleString()} lookups / month`,
      },
      ...(isStripeConfigured()
        ? [
            {
              "@type": "Offer",
              name: BILLING_PLANS.pro.name,
              price: "49",
              priceCurrency: "USD",
              description: `${BILLING_PLANS.pro.monthlyLimit.toLocaleString()} lookups / month`,
            },
            {
              "@type": "Offer",
              name: BILLING_PLANS.scale.name,
              price: "199",
              priceCurrency: "USD",
              description: `${BILLING_PLANS.scale.monthlyLimit.toLocaleString()} lookups / month`,
            },
          ]
        : []),
    ],
  };

  return (
    <div className={`${inter.variable} ${martianMono.variable} ${fragmentMono.variable} ${s.lp}`}>
      <TrackView event="lp_view" withUtmSource />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(organization) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(webSiteJsonLd) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(softwareApplicationJsonLd),
        }}
      />

      <header className={s.wrap}>
        <div className={s.bar}>
          <Link href="/" className={s.mark} aria-label="vet402 home">
            <span>vet</span>
            <span>402</span>
          </Link>
          <nav aria-label="Main navigation" className={s.nav}>
            <TrackedLink href="/docs/api" event="nav_click" props={{ label: "Docs", position: "lp_bar" }}>
              Docs
            </TrackedLink>
            <TrackedLink href="/about" event="nav_click" props={{ label: "About", position: "lp_bar" }}>
              About
            </TrackedLink>
          </nav>
        </div>
      </header>

      <main className={s.wrap}>
        <section aria-labelledby="lp-title" className={s.hero}>
          <div className={s.heroText}>
            <h1 id="lp-title" className={s.h1}>
              Safe payments between AI agents and the APIs they buy from.
            </h1>
            <p className={s.lede}>
              vet402 buys from x402 APIs, the ones that ask an agent to pay before they answer, and records whether a
              real answer came back. Your agent can check a seller and cap its spending before it pays. Your API can
              check the wallet that pays it.
            </p>
            <div className={s.actions}>
              <TrackedLink
                href="/docs/api#quickstart"
                event="lp_cta_click"
                props={{ position: "hero_buyer" }}
                className={s.btn}
              >
                Add to an agent that pays
              </TrackedLink>
              <TrackedLink
                href="/docs/api#packages"
                event="lp_cta_click"
                props={{ position: "hero_seller" }}
                className={s.btnQuiet}
              >
                Add to an API you sell
              </TrackedLink>
            </div>
          </div>

          <div className={s.heroNote}>
            <p>
              <Link href="/signup">
                Start free with {BILLING_PLANS.free.monthlyLimit.toLocaleString("en-US")} seller checks a month.
              </Link>
            </p>
            {isStripeConfigured() ? (
              <p>
                Pro is ${BILLING_PLANS.pro.monthlyUsd} a month. Scale is ${BILLING_PLANS.scale.monthlyUsd} a month.
              </p>
            ) : null}
          </div>

          {ledger && readAt ? (
            <div className={s.heroFacts}>
              <dl className={s.facts} aria-label="The public ledger in four counts">
                <div className={s.fact}>
                  <dt>Days running</dt>
                  <dd>{days !== null ? fmt(days) : "n/a"}</dd>
                  <dd className={s.factSince}>since {FIRST_SETTLED_AT.slice(0, 10)}</dd>
                </div>
                <div className={s.fact}>
                  <dt>Settled purchases</dt>
                  <dd>{fmt(ledger.settled)}</dd>
                </div>
                <div className={s.fact}>
                  <dt>Delivered</dt>
                  <dd>{fmt(ledger.delivered)}</dd>
                </div>
                <div className={s.fact}>
                  <dt>Settled, not delivered</dt>
                  <dd>{fmt(notDelivered)}</dd>
                </div>
              </dl>
              <p className={s.readAt}>
                Read from the {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/api/v1/observatory/state" className={s.inlineLink}>
                  state API
                </a>{" "}
                at{" "}
                <time dateTime={readAt}>
                  {ledger.readDate} {ledger.readTime} UTC
                </time>
                . Delivered means a non-empty 2xx. A 4xx is inconclusive, because it can come from the shape of
                vet402&apos;s own request.
                <HomeLivenessNote linkClassName={s.statusLink} />{" "}
                <a
                  href="https://creativecommons.org/licenses/by/4.0/"
                  className={s.inlineLink}
                  rel="noopener"
                >
                  CC BY 4.0
                </a>
                .
              </p>
            </div>
          ) : (
            <p className={s.readAt}>
              <HomeLivenessNote linkClassName={s.statusLink} />
            </p>
          )}

          {receipt ? (
            <figure className={`${s.record} ${s.rise2}`} aria-labelledby="lp-record">
              <figcaption id="lp-record" className={s.recordHead}>
                <span>
                  <b>Latest purchase</b> by vet402
                </span>
                <time dateTime={receipt.attemptedAt}>{utc(receipt.attemptedAt, false)} UTC</time>
              </figcaption>
              <dl className={s.recordRows}>
                <div>
                  <dt>Seller</dt>
                  <dd className={s.mono}>
                    {receipt.host.split(".").map((part, i) => (
                      <span key={i}>
                        {i > 0 ? "." : ""}
                        {i > 0 ? <wbr /> : null}
                        {part}
                      </span>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt>Paid</dt>
                  <dd>
                    {receipt.amount} {receipt.asset} on {receipt.chain}
                  </dd>
                </div>
                <div>
                  <dt>Transaction</dt>
                  <dd className={s.mono}>
                    {isPublicExplorerTxUrl(receipt.txUrl) ? (
                      <a href={receipt.txUrl} className={s.inlineLink} rel="noopener" target="_blank">
                        {receipt.txShort}
                      </a>
                    ) : (
                      receipt.txShort
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Delivered</dt>
                  <dd>
                    <b>{cardDeliveredLabel(receipt)}</b>
                    {receipt.httpStatus !== null ? <span className={s.mono}> · HTTP {receipt.httpStatus}</span> : null}
                  </dd>
                </div>
                {sellerLine ? (
                  <div>
                    <dt>This seller</dt>
                    <dd>
                      {sellerLine.lead}
                      <span className={s.nowrap}>{sellerLine.days}</span>
                      {sellerLine.tail}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p className={s.recordFoot}>
                A real row from the {}
                <a href="/api/v1/observatory/export.csv?days=1">public export</a>, not a sample. A seller check needs no
                key.
              </p>
            </figure>
          ) : null}
        </section>

        <section aria-labelledby="lp-entries" className={s.section}>
          <h2 id="lp-entries" className="sr-only">
            What vet402 helps you do
          </h2>
          <ul className={s.links}>
            {ENTRY_CARDS.map((card) => (
              <li key={card.href}>
                <TrackedLink href={card.href} event={card.event}>
                  <span className={s.linkName}>{card.title}</span>
                  <span className={s.linkTag}>{card.sentence}</span>
                  <span className={`${s.linkTag} ${s.linkCta}`}>
                    {card.linkLabel} →
                  </span>
                </TrackedLink>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className={s.wrap}>
        <div className={s.foot}>
          <div className={s.footGroups}>
            {(
              [
                ["Product", FOOT_PRODUCT],
                ["x402", FOOT_X402],
                ["Record", FOOT_RECORD],
                ["Legal", FOOT_LEGAL],
              ] as const
            ).map(([title, links]) => (
              <div key={title} className={s.footGroup}>
                <p className={s.footGroupLabel}>{title}</p>
                <ul className={s.footLinks}>
                  {links.map((f) =>
                    f.href.startsWith("http") ? (
                      <li key={f.href}>
                        <OutboundAnchor href={f.href} rel="noopener">
                          {f.label}
                        </OutboundAnchor>
                      </li>
                    ) : (
                      <li key={f.href}>
                        <Link href={f.href}>{f.label}</Link>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            ))}
          </div>
          <p className={s.footNote}>
            vet402 is run by KIZUNA Creation. Figures on this page are measurements, shown with the time they were read.
          </p>
        </div>
      </footer>
    </div>
  );
}
