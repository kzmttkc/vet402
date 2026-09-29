// Legal Notice — vet402's operator-disclosure page (2026-07-20; the product
// was renamed from Vouch in August 2026).
//
// 2026-09-29 (adversarial audit, round 4 — regulator / compliance seat):
// this page used to say that Japan's Act on Specified Commercial Transactions
// "does not currently apply" because vet402 is B2B. That position no longer
// matched the product: anyone can create an account at /signup and pay
// US$49 / US$199 a month from the dashboard, and live Stripe keys are
// registered in production. The page now carries the statutory disclosure
// (Art. 11), with the proprietor's legal name, address and phone number
// withheld under the Art. 11 proviso (provided without delay on request).
// Whether a trade name alone satisfies the "seller" line for a sole
// proprietorship is flagged for professional review, not settled here.
//
// The same audit added "Relationships": vet402 calls itself independent while
// applying to, and winning prizes from, parties connected to networks it
// measures. Each row below was taken from the operator's own records
// (grant and hackathon ledgers), not from memory; a row changes only when
// the record changes. Personal investments of the operator are out of scope
// of this page by owner instruction and are not listed.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { BILLING_PLANS } from "@/lib/billing/plans";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

export const metadata: Metadata = pageMetadata({
  // 2026-08-13 [m2]: 二重サフィックス解消（template が " | vet402" を付ける）。
  title: "Legal Notice",
  description:
    "Operator, commercial-transactions disclosure, funding relationships and contact information for vet402.",
  path: "/legal/notice",
});

const PLAN_ORDER = ["free", "pro", "scale"] as const;

/**
 * Funding relationships, as of the revision date. Source of each row (operator
 * records, read-only): see the commit that introduced this list.
 * status words: awarded / applied / pending / declined / entered / registered.
 */
const RELATIONSHIPS: { who: string; what: string; status: string }[] = [
  {
    who: "ETHOnline 2026 (ETHGlobal) — Bazantic prize",
    what: "vet402's pre-payment gate payOrRefuse won the prize “Help an Agent Use Your Hackathon Project” (500 USDC), announced 2026-09-17.",
    status: "Awarded",
  },
  {
    who: "Circle — Circle Developer Grants, Cohort 2",
    what: "Grant application sent 2026-09-23. Circle issues USDC and runs Arc and Circle Gateway, which vet402 measures.",
    status: "Applied — pending",
  },
  {
    who: "Base Ecosystem Fund",
    what: "Application for investment (not a grant) sent 2026-09-16. vet402 measures payments on Base.",
    status: "Applied — pending",
  },
  {
    who: "Base Builder Grants",
    what: "Nomination submitted 2026-08-25. The program says it does not reply to all nominations.",
    status: "Applied — no decision received",
  },
  {
    who: "Ethereum Foundation — Ecosystem Support Program (office hours)",
    what: "Request sent 2026-09-16; declined by the program on 2026-09-28.",
    status: "Declined",
  },
  {
    who: "Octant",
    what: "Project intake form submitted 2026-08-27.",
    status: "Applied — no decision received",
  },
  {
    who: "IPA (Information-technology Promotion Agency, Japan) — MITOU Advanced",
    what: "Application for vet402's work sent 2026-09-23. IPA is a Japanese public agency, not a network vet402 measures.",
    status: "Applied — pending",
  },
  {
    who: "ETHGlobal Tokyo 2026",
    what: "Hackathon entry, 2026-09-25 to 09-27.",
    status: "Entered — no prize recorded",
  },
  {
    who: "Algorand Global x402 Challenge",
    what: "Entered 2026-09-27; submission due 2026-09-30. vet402 buys from x402 sellers on Algorand.",
    status: "Entered — pending",
  },
  {
    who: "Colosseum — Crypto World’s Fair (Solana)",
    what: "Registered 2026-09-28; nothing submitted yet. vet402 measures payments on Solana.",
    status: "Registered",
  },
];

export default async function LegalNoticePage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Legal Notice", path: "/legal/notice" },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet space-y-8 text-sm text-brand">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
        />
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Instrument: legal notice</span>
            <span>
              {/* この頁のシアン1点。改訂日という事実。 */}
              Revision: <span className="text-signal">September 29, 2026</span>
            </span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>September 2026</span>
          </div>
        </div>
        <div>
          <h1 className="doc-title mt-10">Legal Notice</h1>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
          <p className="doc-note mt-3 text-center">Last updated: September 29, 2026</p>
        </div>

        <section className="space-y-2">
          <h2 className="sec-head">How vet402 is operated</h2>
          <p>
            vet402 (formerly known as Vouch) is developed and operated by KIZUNA Creation, a sole
            proprietorship established in Japan. The product was renamed in August 2026; the
            operator, the service, and these pages are otherwise unchanged. It is built for agent
            developers who need to verify an x402 endpoint before paying it, and for the service
            operators who accept those payments. Anyone can create an account and pay for a plan
            from the dashboard, so the disclosure below applies to the paid plans.
          </p>
        </section>

        {/* 2026-09-29: 特商法 11 条の表示。値は実装（src/lib/billing/*）に合わせる。 */}
        <section id="commercial-transactions" className="scroll-mt-24 space-y-3">
          <h2 className="sec-head">
            Disclosure under Japan&apos;s Act on Specified Commercial Transactions
          </h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-brand-deep">Seller</dt>
              <dd className="mt-1">
                KIZUNA Creation (trade name of a sole proprietorship established in Japan)
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">
                Person responsible for operations, address, and telephone number
              </dt>
              <dd className="mt-1">
                We will provide these without delay on request (proviso to Article 11 of the Act).
                Ask by email at{" "}
                <a className="doc-link" href={SUPPORT_MAILTO}>
                  {SUPPORT_EMAIL}
                </a>{" "}
                and we reply by email. No reason for the request is needed.
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">Contact</dt>
              <dd className="mt-1">
                <a className="doc-link" href={SUPPORT_MAILTO}>
                  {SUPPORT_EMAIL}
                </a>{" "}
                (email)
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">Price</dt>
              <dd className="mt-1">
                <ul className="list-disc space-y-1 pl-5">
                  {PLAN_ORDER.map((id) => {
                    const plan = BILLING_PLANS[id];
                    return (
                      <li key={id}>
                        {plan.name}: US${plan.monthlyUsd} per month (
                        {plan.monthlyLimit.toLocaleString("en-US")} lookups a month)
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2">
                  Prices are in US dollars. The listed price is the full amount charged each month;
                  no tax is added on top at checkout. The price that applies is the one shown on the
                  Billing page when you pay.
                </p>
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">Other charges</dt>
              <dd className="mt-1">
                None from vet402. Currency-conversion or other fees your card issuer charges, and
                the cost of your internet connection, are yours.
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">Payment method</dt>
              <dd className="mt-1">
                Payment through Stripe Checkout (payment card, and any other method Stripe offers on
                that page). We do not see or store card numbers.
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">When you pay</dt>
              <dd className="mt-1">
                The first month is charged when you complete Stripe Checkout. The subscription then
                renews automatically every month and is charged in advance at the start of each
                monthly period until you cancel. If you switch between Pro and Scale, Stripe
                prorates the difference on your next invoice (a charge for an upgrade, a credit for
                a downgrade).
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">When the service is provided</dt>
              <dd className="mt-1">
                The paid monthly quota applies to your account as soon as Stripe tells us the
                payment succeeded. The Billing page shows the new plan once that notice arrives.
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">Cancellation</dt>
              <dd className="mt-1">
                Cancel at any time from Billing → &quot;Manage subscription&quot; (the Stripe
                customer portal). There is no cancellation fee. The paid quota continues until the
                end of the current period, then the account returns to Free.
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">Refunds</dt>
              <dd className="mt-1">
                The service is digital and is provided as soon as payment succeeds, so we do not
                refund unused lookups or unused time on a cancelled period, except where the law
                requires a refund. Details are in{" "}
                <a className="doc-link" href="/legal/terms#paid-subscriptions">
                  section 16 of the Terms
                </a>
                .
              </dd>
            </div>
            <div>
              <dt className="text-brand-deep">Operating environment</dt>
              <dd className="mt-1">
                API: any HTTPS client. Dashboard: a current version of a major web browser with
                JavaScript and cookies enabled (one strictly necessary login cookie; see the{" "}
                <a className="doc-link" href="/legal/privacy">
                  Privacy Policy
                </a>
                ).
              </dd>
            </div>
          </dl>
        </section>

        {/* 2026-09-29: 独立性の開示。記録で確かめられた事実だけを載せる。 */}
        <section id="relationships" className="scroll-mt-24 space-y-3">
          <h2 className="sec-head">Relationships: grants, prizes and applications</h2>
          <p>
            vet402 calls itself an independent measurement. So that you can judge that for
            yourself, these are the grants, prizes and funding applications in our records as of
            September 29, 2026, including those involving networks or payment companies whose
            payments we measure. &quot;Applied&quot; means we sent an application and have received
            no money from it; &quot;pending&quot; means no decision has been announced.
          </p>
          <ul className="space-y-3">
            {RELATIONSHIPS.map((r) => (
              <li key={r.who} className="border-l border-hair pl-3">
                <p className="text-brand-deep">{r.who}</p>
                <p className="mt-1">{r.what}</p>
                <p className="mt-1 doc-note">Status: {r.status}</p>
              </li>
            ))}
          </ul>
          <p>
            Separately, vet402 pays ordinary list prices to the businesses it uses: it buys from
            x402 sellers with its own funds to produce the measurement record, pays network fees on
            each chain, and bills paid plans through Stripe, one of the companies behind Tempo, a
            network we measure. None of these is funding.
          </p>
          <p>
            <strong>Our rule:</strong> no grant, prize, application or payment changes how we
            measure. The same published{" "}
            <a className="doc-link" href="/observatory/methodology">
              methodology
            </a>{" "}
            and publication gate apply to each endpoint whoever the seller, the network or the
            funder is. We update this list when an application is decided or a new one is sent.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Why the proprietor&apos;s personal details are not on this page</h2>
          <p>
            The operator&apos;s trade name is disclosed above. The proprietor&apos;s legal name,
            home address and phone number are kept off this public page, as many independent
            developers do, and are provided without delay to anyone who asks by email, as the
            disclosure above says.
          </p>
        </section>

        <section id="contact" className="scroll-mt-24 space-y-2">
          <h2 className="sec-head">Contact / disclosure requests</h2>
          <p>
            For support, billing questions, or to request operator disclosure details, email{" "}
            <a className="doc-link" href={SUPPORT_MAILTO}>
              {SUPPORT_EMAIL}
            </a>
            . We aim to respond within a few business days.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="sec-head">Data handling</h2>
          <p>
            See the{" "}
            <a className="doc-link" href="/legal/privacy">
              Privacy Policy
            </a>{" "}
            for what we collect and how it is used, and the{" "}
            <a className="doc-link" href="/legal/terms">
              Terms of Service
            </a>{" "}
            for the terms of use.
          </p>
        </section>
      </article>
    </main>
  );
}
