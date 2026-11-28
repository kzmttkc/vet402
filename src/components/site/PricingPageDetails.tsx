import Link from "next/link";
import { BILLING_PLANS } from "@/lib/billing/plans";
import {
  MAX_OBSERVATORY_WATCH_CLAIMS_PER_KEY,
  MAX_WATCHLIST_PER_KEY,
  MAX_WEBHOOKS_PER_KEY,
} from "@/lib/billing/key-feature-limits";
import { keylessDecisionPerMinute, keylessResolvePerMinute } from "@/lib/api/keyless-limits";

const fmt = (n: number) => n.toLocaleString("en-US");

export function PricingPageDetails() {
  const freeLimit = fmt(BILLING_PLANS.free.monthlyLimit);
  return (
    <div className="mt-10 space-y-8 text-[0.84375rem] text-brand">
      <section className="space-y-2" aria-labelledby="pricing-quota">
        <h2 id="pricing-quota" className="sec-head">
          How the monthly score quota works
        </h2>
        <p className="doc-p">
          The quota counts calls made with an API key. A score lookup (
          <code className="text-brand-deep">GET /api/v1/agents/{"{agent_id}"}/score</code>,{" "}
          <code className="text-brand-deep">/api/v1/wallets/{"{address}"}/score</code>, or{" "}
          <code className="text-brand-deep">/api/v1/payees/{"{address}"}/score</code>) and a keyed{" "}
          <code className="text-brand-deep">GET /api/v1/resources/{"{resource_id}"}/decision</code> are one unit each;{" "}
          <code className="text-brand-deep">POST /api/v1/scores/batch</code> with <code className="text-brand-deep">N</code> targets is{" "}
          <code className="text-brand-deep">N</code> units. Other keyed routes also spend units; responses that spend units carry{" "}
          <code className="text-brand-deep">X-RateLimit-Used</code>.
          One quota pool covers the account and is shared across its API keys. The counter resets at 00:00 UTC on the first day of each calendar
          month; unused units do not roll over.
        </p>
        <p className="doc-p">
          Score history (<code className="text-brand-deep">GET /api/v1/agents/{"{agent_id}"}/history</code>) requires Pro or
          Scale; Free receives <code className="text-brand-deep">403</code> on that path.
        </p>
      </section>

      <section className="space-y-2" aria-labelledby="pricing-keyless">
        <h2 id="pricing-keyless" className="sec-head">
          Keyless seller checks
        </h2>
        <p className="doc-p">
          Seller checks at <code className="text-brand-deep">GET /api/v1/check</code> need no API key and do not spend the monthly
          score quota. Requests without a key to{" "}
          <code className="text-brand-deep">/api/v1/resources/{"{resource_id}"}/decision</code> and{" "}
          <code className="text-brand-deep">/api/v1/resolve</code> also do not spend that quota; they are limited per IP instead
          (while keyless reads are available, <code className="text-brand-deep">/decision</code> allows{" "}
          {keylessDecisionPerMinute()} requests a minute per IP and <code className="text-brand-deep">/resolve</code> allows{" "}
          {keylessResolvePerMinute()}).
        </p>
      </section>

      <section className="space-y-2" aria-labelledby="pricing-key-limits">
        <h2 id="pricing-key-limits" className="sec-head">
          Per-key limits (today)
        </h2>
        <p className="doc-p">
          Free, Pro, and Scale share the same per-key caps today. The API enforces these numbers.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-brand-deep">
          <li>Webhook endpoints: {MAX_WEBHOOKS_PER_KEY} per key</li>
          <li>Watchlist targets: {MAX_WATCHLIST_PER_KEY} per key</li>
          <li>Observatory payee-wallet claims (delist alerts): {MAX_OBSERVATORY_WATCH_CLAIMS_PER_KEY} wallets per key</li>
        </ul>
      </section>

      <section className="space-y-2" aria-labelledby="pricing-integrity">
        <h2 id="pricing-integrity" className="sec-head">
          Measurement is not for sale
        </h2>
        <p className="doc-p">
          Paid tiers raise the monthly lookup quota and add score history. They do not change how vet402 measures sellers, how often vet402 buys
          on the public record, or how results are published or corrected. See the{" "}
          <Link href="/integrity" className="doc-link">
            Integrity Terms
          </Link>
          .
        </p>
      </section>

      <section className="space-y-2" aria-labelledby="pricing-availability">
        <h2 id="pricing-availability" className="sec-head">
          Availability
        </h2>
        <p className="doc-p">
          vet402 is in beta. API and dashboard access are best-effort; there is no uptime SLA or response-time commitment on support
          mail. See <Link href="/docs/api#availability" className="doc-link">Availability</Link> in the API docs.
        </p>
      </section>

      <section className="space-y-2" aria-labelledby="pricing-billing">
        <h2 id="pricing-billing" className="sec-head">
          Billing, tax, and refunds
        </h2>
        <p className="doc-p">
          Paid plans bill through Stripe in US dollars after an API key exists. The price shown on Billing when checkout completes is
          the full charge; Japan consumption tax is not added on checkout. vet402 operates as a consumption-tax-exempt sole
          proprietorship in Japan and is not registered as a qualified invoice issuer; qualified invoices cannot be issued.
          Subscriptions renew monthly in advance until cancelled. Unused score lookups and unused time on a cancelled period are not
          refunded except where the law requires it. Details are in{" "}
          <Link href="/legal/terms#paid-subscriptions" className="doc-link">
            Terms section 16
          </Link>{" "}
          and the <Link href="/legal/notice#commercial-transactions" className="doc-link">Legal Notice</Link>.
        </p>
        <p className="doc-note">
          Free tier today: {freeLimit} score lookups a month at {BILLING_PLANS.free.priceLabel}. Pro and Scale prices in the table above
          come from the same plan definitions Billing uses.
        </p>
      </section>
    </div>
  );
}