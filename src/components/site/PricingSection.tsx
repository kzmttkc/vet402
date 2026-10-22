/**
 * PricingSection — Appendix A of the memo.
 *
 * Plan names, prices and limits come from the single source of truth
 * (src/lib/billing/plans.ts) instead of being hardcoded here, so this cannot
 * drift from what /dashboard/billing and Stripe actually charge.
 *
 * 2026-08-13 vet402: three price cards became one fact table. Cards of equal
 * weight are the category default and say nothing; a table lets the three
 * quotas be read against each other in one glance, with the digits in a
 * tabular column. The section keeps its `#pricing` id — the header nav and
 * external links point at it.
 */

import Link from "next/link";
import TrackedLink from "@/components/site/TrackedLink";
import { TableScroll } from "@/components/site/TableScroll";
import { BILLING_PLANS } from "@/lib/billing/plans";
import { buttonClass } from "@/components/ui/Button";

const PLAN_ORDER = ["free", "pro", "scale"] as const;

const INCLUDES: Record<(typeof PLAN_ORDER)[number], string> = {
  free: "REST, MCP and x402 middleware, TypeScript SDK",
  pro: "Everything in Free, plus score history and priority support",
  scale: "Everything in Pro, at the highest rate limit",
};

export function PricingSection() {
  return (
    <section id="pricing" className="scroll-mt-24">
      <h2 className="sec-head">
        <span className="sec-no">A.</span>
        <span>Access tiers</span>
      </h2>
      <p className="doc-p">
        Usage-based. The free tier is enough to wire a check into an x402 flow and see real results
        before committing to anything.
      </p>

      {/* 2026-08-13 UX監査R1 [D1]: 375px で表の実幅 365px に対して可視域 309px、
          つまり INCLUDES 列（各段に何が付くか＝価格表で価格の次に効く列）が
          最初から画面外に出ていた。LP §2 の検証レベル表が既に採っている手
          （幅が足りない画面では表をやめて定義リストで積む）をここにも当てる。
          表と定義リストは同じ BILLING_PLANS / INCLUDES から出ているので、
          片方だけが古くなることはない。 */}
      <TableScroll
        label="vet402 access tiers"
        className="hidden min-[800px]:block"
      >
        <table className="fact-table">
          <caption className="sr-only">vet402 access tiers, monthly quota and what each includes</caption>
          <thead>
            <tr>
              <th scope="col">Tier</th>
              <th scope="col" className="num">
                Price
              </th>
              <th scope="col" className="num">
                Lookups / month
              </th>
              <th scope="col">Includes</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_ORDER.map((id) => {
              const plan = BILLING_PLANS[id];
              return (
                <tr key={id}>
                  <td>{plan.name}</td>
                  <td className="num whitespace-nowrap text-brand-deep">{plan.priceLabel}</td>
                  <td className="num whitespace-nowrap text-brand-deep">
                    {plan.monthlyLimit.toLocaleString("en-US")}
                  </td>
                  <td>{INCLUDES[id]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>

      <dl className="mt-6 min-[800px]:hidden">
        {PLAN_ORDER.map((id) => {
          const plan = BILLING_PLANS[id];
          return (
            <div key={id} className="border-t border-hair py-4 first:border-t-brand-deep">
              <dt className="flex items-baseline justify-between gap-3 font-[family-name:var(--font-display)] font-semibold text-brand-deep">
                <span>{plan.name}</span>
                <span className="whitespace-nowrap tabular-nums">{plan.priceLabel}</span>
              </dt>
              <dd className="mt-2 space-y-1 text-[0.84375rem] text-brand">
                <p className="text-brand-deep">
                  {plan.monthlyLimit.toLocaleString("en-US")} lookups / month
                </p>
                <p>{INCLUDES[id]}</p>
              </dd>
            </div>
          );
        })}
      </dl>

      {/* 2026-08-06 growth: pricing_cta_click{plan} — which plan people click is
          the only pre-signup price-sensitivity signal we have (all CTAs land on
          the same /signup URL, so the pageview alone can't tell them apart).
          2026-08-13: the three per-card buttons became one, because the table
          above already carries the comparison the cards were making — and the
          two paid buttons pointed at /signup anyway. The upgrade path is named
          in prose instead of being a second button that lands an anonymous
          visitor on a page that needs a session. */}
      <div className="mt-7">
        <TrackedLink
          href="/signup"
          event="pricing_cta_click"
          props={{ plan: "free" }}
          className={buttonClass({ size: "md" })}
        >
          Get a free API key
        </TrackedLink>
        <p className="doc-note mt-4">
          Paid tiers are upgraded from Billing once a key exists. No card is required to start.
          Already have a key?{" "}
          <Link href="/dashboard/billing" className="doc-link">
            Open Billing
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
