"use client";

import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard/client";
import { dashboardErrorMessage } from "@/lib/dashboard/errors";
import { buttonClass } from "@/components/ui/Button";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { track } from "@/lib/analytics";

type BillingInfo = {
  plan: string;
  email: string | null;
  stripeConfigured: boolean;
  billingHealth: "ok" | "past_due" | "canceled" | null;
  canChangePlan: boolean;
  plans: Record<
    string,
    { name: string; monthlyLimit: number; monthlyUsd: number; priceLabel: string }
  >;
};

type PaidPlanId = "pro" | "scale";

export default function DashboardBillingPage() {
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [checkoutStatus] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("checkout");
  });
  const [planChanged, setPlanChanged] = useState(false);
  // 2026-09-29 (特商法 12 条の 6): 申込みの最終確認。Upgrade はこの確認を開くだけで、
  // Stripe へ進む（または既存の契約を変える）のは確認の中のボタンだけ。
  const [confirming, setConfirming] = useState<PaidPlanId | null>(null);

  useEffect(() => {
    track("billing_view");
    dashboardFetch<BillingInfo>("/api/billing/checkout")
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : "load_failed"));
  }, []);

  async function upgrade(plan: PaidPlanId) {
    setLoading(plan);
    setError(null);
    setPlanChanged(false);
    try {
      const data = await dashboardFetch<{ url?: string; updated?: boolean }>(
        "/api/billing/checkout",
        {
          method: "POST",
          body: JSON.stringify({ plan }),
        },
      );

      if (data.url) {
        // No existing subscription — Stripe Checkout will collect payment.
        globalThis.location.assign(data.url);
        return;
      }

      // Existing subscription was changed in place (no redirect needed).
      setPlanChanged(true);
      setConfirming(null);
      setLoading(null);
      dashboardFetch<BillingInfo>("/api/billing/checkout").then(setInfo).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "checkout_failed");
      setLoading(null);
    }
  }

  async function openPortal() {
    setLoading("portal");
    setError(null);
    try {
      const data = await dashboardFetch<{ url: string }>(
        "/api/billing/checkout?action=portal",
      );
      globalThis.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "portal_failed");
      setLoading(null);
    }
  }

  if (!info) {
    if (error) {
      return (
        <p role="alert" aria-live="assertive" className="text-sm text-red-700">
          {dashboardErrorMessage(error)}
        </p>
      );
    }
    return <p className="text-sm text-zinc-700">Loading billing...</p>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">Billing</h2>
        <p className="dash-lede">
          Quota is shared across every key on this account. Free is 1,000 lookups a month.
          Upgrading agrees to the{" "}
          <a className="underline" href="/legal/terms#paid-subscriptions">
            Terms of Service
          </a>
          , including paid subscriptions (section 16). No refunds for unused lookups. Cancel from
          Manage subscription; the account returns to Free at period end. Billing questions:{" "}
          <a className="underline" href={SUPPORT_MAILTO}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </div>

      {checkoutStatus === "success" && (
        <p className="dash-alert dash-alert-ok">
          Payment successful. Your plan will update shortly.
        </p>
      )}

      {checkoutStatus === "cancelled" && (
        <p className="dash-alert dash-alert-muted">
          Checkout cancelled. No charge was made. You are still on {info.plan}.
        </p>
      )}

      {(!info.canChangePlan || info.billingHealth === "past_due") && (
        <p className="dash-alert dash-alert-error">
          {info.billingHealth === "past_due"
            ? "Payment failed. Your current plan stays until Stripe finishes retrying. Update the card via Manage subscription."
            : "This subscription cannot be changed here. Update the card or complete payment via Manage subscription."}
        </p>
      )}

      {planChanged && (
        <p className="dash-alert dash-alert-ok">
          Plan updated. Stripe may prorate the difference on the next invoice.
        </p>
      )}

      {error && (
        <p role="alert" aria-live="assertive" className="dash-alert dash-alert-error">
          {dashboardErrorMessage(error)}
        </p>
      )}

      <div className="dash-card">
        <p className="dash-caption">Current plan</p>
        <p className="mt-2 font-[family-name:var(--font-display)] text-2xl font-semibold capitalize tracking-tight">
          {info.plan}
        </p>
        {info.email && <p className="mt-1 text-sm text-zinc-600">{info.email}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {(["free", "pro", "scale"] as const).map((planId) => {
          const plan = info.plans[planId];
          const isCurrent = info.plan === planId;
          return (
            <div
              key={planId}
              className={`dash-card ${isCurrent ? "border-zinc-900 bg-zinc-50" : ""}`}
            >
              <p className="font-semibold text-zinc-900">{plan.name}</p>
              <p className="mt-2 font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">
                {plan.priceLabel}
              </p>
              <p className="mt-2 text-sm text-zinc-600">
                {plan.monthlyLimit.toLocaleString()} lookups / month
              </p>
              {planId !== "free" && info.stripeConfigured && !isCurrent && info.canChangePlan && (
                <button
                  type="button"
                  disabled={loading !== null}
                  aria-expanded={confirming === planId}
                  aria-controls="order-confirmation"
                  onClick={() => {
                    setError(null);
                    setConfirming(planId);
                  }}
                  className={buttonClass({ className: "mt-4 w-full" })}
                >
                  {`Upgrade to ${plan.name}`}
                </button>
              )}
              {isCurrent && (
                <p className="mt-4 text-xs font-medium uppercase tracking-wide text-zinc-600">
                  Current
                </p>
              )}
            </div>
          );
        })}
      </div>

      {confirming && info.stripeConfigured && info.canChangePlan && (
        <OrderConfirmation
          plan={info.plans[confirming]}
          planId={confirming}
          changeInPlace={info.plan !== "free"}
          busy={loading !== null}
          loadingThis={loading === confirming}
          onConfirm={() => upgrade(confirming)}
          onBack={() => setConfirming(null)}
        />
      )}

      {(info.stripeConfigured && (info.plan !== "free" || !info.canChangePlan)) && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={openPortal}
            disabled={loading !== null}
            className={buttonClass({ variant: "secondary", className: "px-4 py-2" })}
          >
            {loading === "portal" ? "Opening..." : "Manage subscription"}
          </button>
          <p className="text-sm text-zinc-600">
            Change card, download invoices, or cancel from the Stripe portal. Cancel returns the
            account to Free at period end.
          </p>
        </div>
      )}

      {!info.stripeConfigured && (
        <p className="text-sm text-zinc-600">
          Paid upgrades are not enabled on this deploy. The Free quota still applies.
        </p>
      )}
    </div>
  );
}

/**
 * 最終確認画面（特定商取引法 12 条の 6）。申込みを確定するボタンの直前に、
 * プラン・価格・課金周期・自動更新・支払時期・提供時期・解約方法を並べる。
 * 値は src/lib/billing/*（Checkout は mode: "subscription"・税の自動計算なし、
 * プラン変更は proration_behavior: "create_prorations"）の実装に合わせてある。
 */
function OrderConfirmation({
  plan,
  planId,
  changeInPlace,
  busy,
  loadingThis,
  onConfirm,
  onBack,
}: {
  plan: { name: string; monthlyLimit: number; monthlyUsd: number };
  planId: PaidPlanId;
  changeInPlace: boolean;
  busy: boolean;
  loadingThis: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const price = `US$${plan.monthlyUsd} per month`;
  return (
    <section
      id="order-confirmation"
      aria-labelledby="order-confirmation-title"
      className="dash-card space-y-4"
      data-plan={planId}
    >
      <h3 id="order-confirmation-title" className="font-semibold text-zinc-900">
        Confirm your order: {plan.name}
      </h3>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-zinc-600">Plan</dt>
        <dd className="text-zinc-900">
          {plan.name} — {plan.monthlyLimit.toLocaleString("en-US")} lookups a month, shared across
          the keys on this account
        </dd>
        <dt className="text-zinc-600">Price</dt>
        <dd className="text-zinc-900">
          {price}. Prices are in US dollars; no tax is added at checkout.
        </dd>
        <dt className="text-zinc-600">Billing cycle</dt>
        <dd className="text-zinc-900">
          Monthly. The subscription renews automatically every month until you cancel.
        </dd>
        <dt className="text-zinc-600">When you pay</dt>
        <dd className="text-zinc-900">
          {changeInPlace
            ? `Your current subscription is changed in place. Stripe prorates the difference for the rest of this period on your next invoice (a charge for an upgrade, a credit for a downgrade); after that, ${price} is charged in advance at the start of each period.`
            : `The first month is charged when you complete payment on the next page (Stripe Checkout). After that, ${price} is charged in advance at the start of each monthly period.`}
        </dd>
        <dt className="text-zinc-600">When it starts</dt>
        <dd className="text-zinc-900">
          The {plan.name} quota applies as soon as Stripe tells us the payment succeeded.
        </dd>
        <dt className="text-zinc-600">How to cancel</dt>
        <dd className="text-zinc-900">
          Any time from this page with &quot;Manage subscription&quot; (Stripe customer portal). The
          paid quota continues until the end of the current period, then the account returns to
          Free. No refunds for unused lookups or unused time.
        </dd>
      </dl>
      <p className="text-sm text-zinc-600">
        By continuing you agree to the{" "}
        <a className="underline" href="/legal/terms#paid-subscriptions">
          Terms of Service
        </a>{" "}
        (section 16). Seller and legal disclosure:{" "}
        <a className="underline" href="/legal/notice#commercial-transactions">
          Legal notice
        </a>
        .
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={buttonClass({ className: "px-4 py-2" })}
        >
          {loadingThis
            ? changeInPlace
              ? "Changing plan..."
              : "Redirecting..."
            : changeInPlace
              ? `Change plan to ${plan.name} (${price})`
              : `Continue to payment (${price})`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onBack}
          className={buttonClass({ variant: "secondary", className: "px-4 py-2" })}
        >
          Back
        </button>
      </div>
    </section>
  );
}
