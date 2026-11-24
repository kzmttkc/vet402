import type { Viewport } from "next";
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
import { PasteCheck } from "@/components/site/home/PasteCheck";
import HomePurchaseSparkline from "@/components/site/home/HomePurchaseSparkline";
import s from "./home.module.css";

export const metadata = pageMetadata({
  title: "Know if an x402 seller delivers before your agent pays | vet402",
  description:
    "vet402 pays x402 sellers with its own money and publishes what came back. Paste a URL to see the record. Settlement assets include USDC.",
  path: "/",
});

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#090909" },
  ],
};

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
    href: "/#lp-paste-url",
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

const FOOT_MAIN = [
  { label: "Methodology", href: "/observatory/methodology" },
  { label: "State", href: "/observatory/state" },
  { label: "Docs", href: "/docs/api" },
  { label: "The memo", href: "/memo" },
  { label: "GitHub", href: "https://github.com/vet402/vet402" },
] as const;

const FOOT_LEGAL = [{ label: "Privacy", href: "/legal/privacy" }] as const;

export default async function Home() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const [stats, example] = await Promise.all([
    getObservatoryStatsCached().catch(() => null),
    getHomeExampleCached().catch(() => null),
  ]);
  const ledger = homeLedgerOf(stats);
  const readAt = stats?.readAt ?? null;
  const days = readAt ? daysBetween(FIRST_SETTLED_AT, readAt) : null;
  const inconclusiveSettled = stats?.l1.inconclusiveSettled ?? 0;
  const notDelivered = ledger
    ? Math.max(0, ledger.settled - ledger.delivered - inconclusiveSettled)
    : 0;
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
        description: `${BILLING_PLANS.free.monthlyLimit.toLocaleString()} score lookups / month`,
      },
      ...(isStripeConfigured()
        ? [
            {
              "@type": "Offer",
              name: BILLING_PLANS.pro.name,
              price: "49",
              priceCurrency: "USD",
              description: `${BILLING_PLANS.pro.monthlyLimit.toLocaleString()} score lookups / month`,
            },
            {
              "@type": "Offer",
              name: BILLING_PLANS.scale.name,
              price: "199",
              priceCurrency: "USD",
              description: `${BILLING_PLANS.scale.monthlyLimit.toLocaleString()} score lookups / month`,
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
            <TrackedLink
              href="#lp-paste-url"
              event="nav_click"
              props={{ label: "Check", position: "lp_bar" }}
            >
              Check
            </TrackedLink>
            <TrackedLink
              href="/observatory"
              event="lp_cta_click"
              props={{ position: "hero_observatory" }}
            >
              Records
            </TrackedLink>
          </nav>
        </div>
      </header>

      <main className={s.wrap}>
        <section aria-labelledby="lp-title" className={s.hero}>
          <div className={s.heroText}>
            <h1 id="lp-title" className={s.h1}>
              Know if an x402 seller delivers before your agent pays.
            </h1>
            <p className={s.lede}>
              vet402 pays x402 sellers with its own money and publishes what came back. Paste a URL to see the record.
              These are measurements, not a guarantee.
            </p>
            <PasteCheck cls={s} />
          </div>

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
                  <dd className={s.mono}>{receipt.url}</dd>
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
                {days !== null ? (
                  <>
                    {" "}
                    Days running: {fmt(days)} since {FIRST_SETTLED_AT.slice(0, 10)}.
                  </>
                ) : null}
              </p>
            </figure>
          ) : null}

          {ledger && readAt ? (
            <div className={s.heroFacts}>
              <dl className={s.facts} aria-label="The public ledger in four counts">
                <div className={s.fact}>
                  <dt>Settled purchases</dt>
                  <dd>{fmt(ledger.settled)}</dd>
                </div>
                <div className={s.fact}>
                  <dt>Delivered</dt>
                  <dd>{fmt(ledger.delivered)}</dd>
                </div>
                <div className={s.fact}>
                  <dt>Settled without delivery</dt>
                  <dd>{fmt(notDelivered)}</dd>
                </div>
                <div className={s.fact}>
                  <dt>Settled, inconclusive (4xx)</dt>
                  <dd>{fmt(inconclusiveSettled)}</dd>
                </div>
              </dl>
              <p className={s.readAt}>
                Read from the {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <Link href="/observatory/state" className={s.inlineLink}>
                  public state page
                </Link>{" "}
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
              {days !== null && days >= 2 ? (
                <HomePurchaseSparkline historyDays={Math.min(days, 98)} readDate={ledger.readDate} readTime={ledger.readTime} />
              ) : null}
            </div>
          ) : (
            <p className={s.readAt}>
              <HomeLivenessNote linkClassName={s.statusLink} />
            </p>
          )}
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

        <section className={s.section} aria-labelledby="lp-use-vet402">
          <h2 id="lp-use-vet402" className={s.h2}>
            Use vet402
          </h2>
          <div className={`${s.actions} ${s.actionsSecondary}`}>
            <TrackedLink href="/connect" event="home_cta" props={{ target: "connect_agent" }} className={s.actionLink}>
              Add this check to a paying agent
            </TrackedLink>
            <TrackedLink
              href="/docs/api#packages"
              event="home_cta"
              props={{ target: "record_badge" }}
              className={s.actionLink}
            >
              Add a record badge to an API you sell
            </TrackedLink>
          </div>
        </section>

        <section className={s.section} aria-labelledby="home-pricing">
          <h2 id="home-pricing" className={s.h2}>
            Pricing
          </h2>
          <p className={s.pricingLead}>
            Start free with {BILLING_PLANS.free.monthlyLimit.toLocaleString("en-US")} score lookups a month.{" "}
            <Link href="/pricing" className={s.inlineLink}>
              See pricing
            </Link>
            .
          </p>
          <p className={s.pricingLead}>Seller checks need no key.</p>
        </section>
      </main>

      <footer className={s.wrap}>
        <div className={s.foot}>
          {[FOOT_MAIN, FOOT_LEGAL].map((links, row) => (
            <ul key={row} className={row ? `${s.footLinks} ${s.footLegal}` : s.footLinks}>
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
          ))}
          <p className={s.footNote}>
            vet402 is run by KIZUNA Creation. Figures on this page are measurements, shown with the time they were read.
          </p>
        </div>
      </footer>
    </div>
  );
}
