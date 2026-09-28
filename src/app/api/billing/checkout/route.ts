import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  changeSubscriptionPlan,
  createBillingPortalSession,
  createCheckoutSession,
  getStripe,
  SubscriptionNotChangeableError,
} from "@/lib/billing/stripe";
import {
  BILLING_PLANS,
  isStripeConfigured,
  planFromStripePriceId,
  type PaidPlan,
} from "@/lib/billing/plans";
import {
  checkoutDisposition,
  resolveAccountPlanFromStripe,
} from "@/lib/billing/subscription-status";
import { getAccountById, setAccountStripeIds, updateAccountPlan } from "@/lib/db/accounts";
import { ensureOwnerUserId } from "@/lib/db/api-keys";
import { authorizeDashboardRequest } from "@/lib/dashboard/auth";
import { logServerErrorSafe } from "@/lib/util/log-safe";

const checkoutSchema = z.object({
  plan: z.enum(["pro", "scale"]),
});

export async function POST(request: NextRequest) {
  const auth = await authorizeDashboardRequest(request);
  if (!auth.ok) return auth.error;

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const userId = await ensureOwnerUserId(auth.ctx.apiKeyId);
  const account = await getAccountById(userId);
  if (!account) {
    return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  }

  if (account.plan === parsed.data.plan) {
    return NextResponse.json({ error: "already_on_plan" }, { status: 400 });
  }

  try {
    // If the account already has an active subscription, change its plan in
    // place rather than starting a second Checkout Session — creating a new
    // subscription here would double-bill the customer while the old one is
    // still running.
    if (account.stripeSubscriptionId) {
      try {
        await changeSubscriptionPlan({
          subscriptionId: account.stripeSubscriptionId,
          plan: parsed.data.plan as PaidPlan,
        });

        // Reflect the new plan immediately for a snappy UI; the
        // customer.subscription.updated webhook will re-confirm the same
        // plan once Stripe finishes processing the change, so both paths
        // converge on the same state.
        await updateAccountPlan(account.id, parsed.data.plan);

        return NextResponse.json({ updated: true });
      } catch (error) {
        if (!(error instanceof SubscriptionNotChangeableError)) {
          throw error;
        }
        // past_due / unpaid / incomplete still exist on Stripe. A new
        // Checkout Session would be a second subscription. Canceled ones
        // may start fresh.
        if (checkoutDisposition(error.stripeStatus) !== "new_checkout") {
          return NextResponse.json({ error: "update_payment_method" }, { status: 409 });
        }
      }
    }

    const { url, customerId } = await createCheckoutSession({
      accountId: account.id,
      email: account.email,
      plan: parsed.data.plan as PaidPlan,
      customerId: account.stripeCustomerId,
    });

    if (!account.stripeCustomerId) {
      await setAccountStripeIds(account.id, { stripeCustomerId: customerId });
    }

    return NextResponse.json({ url });
  } catch (error) {
    // 2026-08-15 audit: this used to return `error.message` verbatim. Whatever
    // threw here is Stripe's SDK or the database, and their messages carry
    // internals (price/customer ids, SQL text, host names) that a customer has
    // no reason to see and an attacker can farm by forcing failures. Log the
    // detail server-side, answer with the same fixed code the sibling handler
    // below already uses.
    logServerErrorSafe("billing_checkout", error);
    return NextResponse.json({ error: "checkout_failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const auth = await authorizeDashboardRequest(request);
  if (!auth.ok) return auth.error;

  const userId = await ensureOwnerUserId(auth.ctx.apiKeyId);
  const account = await getAccountById(userId);

  const action = request.nextUrl.searchParams.get("action");

  if (action === "portal") {
    if (!isStripeConfigured() || !account?.stripeCustomerId) {
      return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
    }

    try {
      const url = await createBillingPortalSession(account.stripeCustomerId);
      return NextResponse.json({ url });
    } catch {
      return NextResponse.json({ error: "portal_failed" }, { status: 500 });
    }
  }

  let billingHealth: "ok" | "past_due" | "canceled" | null = null;
  let canChangePlan = true;
  if (isStripeConfigured() && account?.stripeSubscriptionId) {
    try {
      const subscription = await getStripe().subscriptions.retrieve(account.stripeSubscriptionId);
      const priceId = subscription.items.data[0]?.price.id;
      billingHealth = resolveAccountPlanFromStripe({
        stripeStatus: subscription.status,
        pricePlan: priceId ? planFromStripePriceId(priceId) : null,
      }).health;
      canChangePlan = checkoutDisposition(subscription.status) !== "use_portal";
    } catch (error) {
      logServerErrorSafe("billing_status", error);
      canChangePlan = false;
    }
  }

  return NextResponse.json({
    plan: account?.plan ?? auth.ctx.plan,
    email: account?.email ?? null,
    stripeConfigured: isStripeConfigured(),
    billingHealth,
    canChangePlan,
    plans: BILLING_PLANS,
  });
}
