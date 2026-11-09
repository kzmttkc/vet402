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
import { getHomeExampleCached, cardDeliveredLabel, deliveredLine, fmt, sellerRecordParts, utc, type HomeReceipt } from "@/lib/observatory/home-example";
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

/** The newest purchase in the window whose paid request did not count as delivered, for the events list. */
function latestMiss(rows: HomeReceipt[]): HomeReceipt | null {
  return rows.find((r) => !r.delivered && !r.held) ?? null;
}

const STAGES: {
  stage: string;
  buyer: { text: string; live: boolean }[];
  seller: { text: string; live: boolean }[];
}[] = [
  {
    stage: "Before paying",
    buyer: [
      {
        text: "Check a seller: its delivery record, then one answer, ALLOW, WARN or BLOCK.",
        live: true,
      },
    ],
    seller: [
      {
        text: "Score the wallet that wants to pay you before you serve it.",
        live: true,
      },
    ],
  },
  {
    stage: "While paying",
    buyer: [
      {
        text: "A spending cap per payment and per day that runs in your own process.",
        live: true,
      },
    ],
    seller: [
      {
        text: "Middleware for Express, Next.js and Hono that gates the payment before it settles.",
        live: true,
      },
    ],
  },
  {
    stage: "After paying",
    buyer: [
      {
        text: "The purchases vet402 makes, published with their transactions and what came back.",
        live: true,
      },
      { text: "Settle only once the answer has arrived.", live: false },
    ],
    seller: [
      {
        text: "Report a settled payment so your record counts it.",
        live: true,
      },
      {
        text: "One shared desk for both sides when a delivery is disputed.",
        live: false,
      },
    ],
  },
];

const OPEN_DATA = [
  {
    name: "Observatory",
    tag: "Listed x402 endpoints and their latest results",
    href: "/observatory",
  },
  {
    name: "Sellers",
    tag: "What vet402 bought from each host on Base. Other chains are in the export.",
    href: "/sellers",
  },
  {
    name: "State API",
    tag: "The counts on this page, as JSON",
    href: "/api/v1/observatory/state",
    raw: true,
  },
  {
    name: "Export",
    tag: "Purchase rows as CSV, last day",
    href: "/api/v1/observatory/export.csv?days=1",
    raw: true,
  },
  {
    name: "Methodology",
    tag: "What each level and word means",
    href: "/observatory/methodology",
  },
  {
    name: "The memo",
    tag: "The full document this page used to be",
    href: "/memo",
  },
];

const FOOT_PRODUCT = [
  { label: "Docs", href: "/docs/api" },
  { label: "MCP", href: "/docs/mcp" },
  { label: "Get an API key", href: "/signup" },
  { label: "Dashboard", href: "/dashboard" },
] as const;

const FOOT_X402 = [
  { label: "What is x402", href: "/blog/what-is-x402" },
  { label: "Check a seller", href: "/x402/check-a-seller" },
  { label: "x402 by chain", href: "/x402/chains" },
  { label: "Stablecoin payments", href: "/x402/stablecoin-payments" },
  { label: "State of x402", href: "/observatory/state" },
] as const;

const FOOT_RECORD = [
  { label: "About", href: "/about" },
  { label: "FAQ", href: "/faq" },
  { label: "Blog", href: "/blog" },
  { label: "Status", href: "/status" },
  { label: "Corrections", href: "/corrections" },
  { label: "GitHub", href: "https://github.com/kzmttkc/vet402" },
  { label: "X", href: "https://x.com/vet402_com" },
] as const;

const FOOT_LEGAL = [
  { label: "Terms", href: "/legal/terms" },
  { label: "Privacy", href: "/legal/privacy" },
  { label: "Legal notice", href: "/legal/notice" },
] as const;

const EVENT_WORDS = ["zero", "one", "two", "three"];

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
  const miss = example ? latestMiss(example.latest) : null;
  const chains = ledger ? [...ledger.chains].sort((a, b) => b.settled - a.settled) : [];
  const weakest = chains
    .filter((c) => c.settled >= 100)
    .map((c) => ({ ...c, share: c.delivered / c.settled }))
    .sort((a, b) => a.share - b.share)[0];
  const eventCount = 1 + (weakest ? 1 : 0) + (miss ? 1 : 0);

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
                .
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

        {ledger && readAt ? (
          <section aria-labelledby="lp-problem" className={s.section}>
            <h2 id="lp-problem" className={s.h2}>
              A payment on chain says an agent paid. It does not say the API answered.
            </h2>
            <p className={s.body}>
              Since <b>{FIRST_SETTLED_AT.slice(0, 10)}</b>, vet402 has made <b>{fmt(ledger.attempts)}</b> paid attempts
              on <b>{fmt(chains.length)}</b> chains. <b>{fmt(ledger.settled)}</b> of them settled on chain, and the
              results are published. Here {eventCount === 1 ? "is one thing" : `are ${EVENT_WORDS[eventCount]} things`}{" "}
              that record shows.
            </p>
            <ol className={s.events}>
              <li>
                <span className={s.eventWhen}>Whole ledger</span>
                <div>
                  <p className={s.eventLine}>
                    {fmt(notDelivered)} of {fmt(ledger.settled)} settled purchases did not count as delivered.
                  </p>
                  <p className={s.eventNote}>
                    The money moved on chain. Delivered means a non-empty 2xx. Other answers, including 4xx, stay in
                    this count. A 4xx is inconclusive, because it can come from the shape of vet402&apos;s own request.
                    {weakest ? " The weakest chain is next." : null}
                  </p>
                </div>
              </li>
              {weakest ? (
                <li>
                  <span className={s.eventWhen}>{weakest.label}</span>
                  <div>
                    <p className={s.eventLine}>
                      On {weakest.label}, {fmt(weakest.settled - weakest.delivered)} of {fmt(weakest.settled)} settled
                      purchases did not count as delivered.
                    </p>
                    <p className={s.eventNote}>
                      {fmt(weakest.inconclusiveSettled)} of them answered 4xx and are held as inconclusive, because a
                      4xx can come from the shape of vet402&apos;s own request.
                    </p>
                  </div>
                </li>
              ) : null}
              {miss ? (
                <li>
                  <span className={s.eventWhen}>
                    <time dateTime={miss.attemptedAt}>{utc(miss.attemptedAt, false)} UTC</time>
                  </span>
                  <div>
                    <p className={s.eventLine}>
                      vet402 paid {miss.amount} {miss.asset} to <span className={s.mono}>{miss.host}</span> on{" "}
                      {miss.chain}. The answer: {deliveredLine(miss).text}.
                    </p>
                    <p className={s.eventNote}>
                      Transaction{" "}
                      {isPublicExplorerTxUrl(miss.txUrl) ? (
                        <a href={miss.txUrl} className={`${s.inlineLink} ${s.mono}`} rel="noopener" target="_blank">
                          {miss.txShort}
                        </a>
                      ) : (
                        <span className={s.mono}>{miss.txShort}</span>
                      )}
                    </p>
                  </div>
                </li>
              ) : null}
            </ol>
            <p className={s.body}>
              So your agent can ask vet402 before it pays, and stop. The answer comes from those purchases, not from
              what a seller says about itself.
            </p>
          </section>
        ) : null}

        <section aria-labelledby="lp-fit" className={s.section}>
          <h2 id="lp-fit" className={s.h2}>
            Where vet402 sits
          </h2>
          <p className={s.body}>
            One package for the side that pays, one for the side that is paid. Both read the same record.
          </p>
          <ol className={s.flow}>
            <li className={s.part}>
              <p className={s.partName}>Your agent</p>
              <p className={s.partTag}>Holds its own wallet and signs its own payments.</p>
            </li>
            <li className={`${s.part} ${s.partVetSolid}`}>
              <p className={s.partName}>vet402 check</p>
              <p className={s.partTag}>ALLOW, WARN or BLOCK from real purchases, and your spending cap.</p>
            </li>
            <li className={s.part}>
              <p className={s.partName}>x402 payment</p>
              <p className={s.partTag}>Settles on chain in USDC or the asset the seller names.</p>
            </li>
            <li className={`${s.part} ${s.partVet}`}>
              <p className={s.partName}>Seller API with vet402</p>
              <p className={s.partTag}>Scores the paying wallet, then serves the answer vet402 records.</p>
            </li>
          </ol>

          <table className={s.stages}>
            <caption className="sr-only">What vet402 does for each side, and what is live today</caption>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">For the agent that pays</th>
                <th scope="col">For the API that is paid</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map((row) => (
                <tr key={row.stage}>
                  <th scope="row">{row.stage}</th>
                  {(["buyer", "seller"] as const).map((side) => (
                    <td
                      key={side}
                      data-side={side === "buyer" ? "For the agent that pays" : "For the API that is paid"}
                    >
                      {row[side].map((item) => (
                        <p key={item.text} className={s.stageItem}>
                          {item.text}
                          <span className={`${s.state} ${item.live ? s.stateLive : ""}`}>
                            {item.live ? "Live" : "Coming"}
                          </span>
                        </p>
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {ledger ? (
          <section aria-labelledby="chains" className={s.section}>
            <h2 id="chains" className={s.h2}>
              Where purchases settled
            </h2>
            <p className={s.body}>
              Read at {ledger.readDate} {ledger.readTime} UTC. Each row is a chain vet402 has paid on.
            </p>
            <div className={s.tableWrap} tabIndex={0} role="region" aria-label="Settled purchases by chain">
              <table className={s.chains}>
                <thead>
                  <tr>
                    <th scope="col">Chain</th>
                    <th scope="col">Asset</th>
                    <th scope="col" className={s.num}>
                      Settled
                    </th>
                    <th scope="col" className={s.num}>
                      Delivered
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {chains.map((c) => (
                    <tr key={c.chain}>
                      <th scope="row">{c.label}</th>
                      <td>{c.asset}</td>
                      <td className={`${s.num} ${s.mono}`}>{fmt(c.settled)}</td>
                      <td className={`${s.num} ${s.mono}`}>{fmt(c.delivered)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="lp-open" className={s.section}>
          <h2 id="lp-open" className={s.h2}>
            Everything behind these numbers is open
          </h2>
          <p className={s.body}>The data, the method and the old memo are linked below.</p>
          <ul className={s.links}>
            {OPEN_DATA.map((l) => (
              <li key={l.href}>
                {l.raw ? (
                  <a href={l.href}>
                    <span className={s.linkName}>{l.name}</span>
                    <span className={s.linkTag}>{l.tag}</span>
                  </a>
                ) : (
                  <Link href={l.href}>
                    <span className={s.linkName}>{l.name}</span>
                    <span className={s.linkTag}>{l.tag}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="lp-close" className={s.close}>
          <h2 id="lp-close" className={s.closeLine}>
            Give your agent a record to check before it pays.
          </h2>
          <div className={s.actions}>
            <TrackedLink
              href="/docs/api#quickstart"
              event="lp_cta_click"
              props={{ position: "close_buyer" }}
              className={s.btn}
            >
              Add to an agent that pays
            </TrackedLink>
            <TrackedLink
              href="/docs/api#packages"
              event="lp_cta_click"
              props={{ position: "close_seller" }}
              className={s.btnQuiet}
            >
              Add to an API you sell
            </TrackedLink>
          </div>
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
