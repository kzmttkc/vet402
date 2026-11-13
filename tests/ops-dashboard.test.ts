// P3 運用画面（DB なし）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { deliveredRates } from "@/lib/observatory/delivered-rates";
import { p2PartyAccessMessage } from "@/lib/observatory/p2-party-verify";
import {
  OPS_NOT_DELIVERED_RATE_NOTE,
  OPS_VET402_L1_MEASUREMENT_LEDE,
  buildBuyerCard,
  buildSellerCard,
  opsDeliveredRateUnavailableMessage,
  sellerDisputesNoRecordsMessage,
  sellerDisputesTruncatedNote,
} from "@/lib/dashboard/ops-card";
import {
  sellerDashboardAccessMessage,
  verifySellerDashboardAccess,
} from "@/lib/dashboard/seller-access";
import {
  loadBuyerCard,
  loadSellerCard,
  setDisputePurchaseLimitForTests,
  setSellerOpsLoaderForTests,
} from "@/lib/dashboard/ops-data";
import { dispatchOpsDigest } from "@/lib/dashboard/ops-notify";
import { renderOpsDigestEmailDraft } from "@/lib/dashboard/ops-email";
import {
  isSafeWebhookUrl,
  isWebhookEvent,
  setWebhookDeliveryForTests,
} from "@/lib/webhooks";
import { pct1 } from "@/lib/util/pct";

const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;/;
const REREAD_IN_PUBLIC = new RegExp(`\\bre${String.fromCharCode(45)}read\\b`, "i");
const EMPTY_LABEL_BAD = /\b(fail|failed|error)\b/i;
const HYPHEN_COMPOUND = /\b[A-Za-z]+-[A-Za-z]+\b/g;
const HYPHEN_ALLOW = new Set([
  "fail-closed",
  "EIP-191",
  "x402",
  "vet402",
  "payTo",
  "ISO",
  "sm",
  "grid-cols",
  "col-span",
  "font-mono",
  "font-semibold",
  "font-normal",
  "font-display",
  "text-xs",
  "text-sm",
  "border-t",
  "border-zinc",
  "divide-y",
  "divide-zinc",
  "gap-x",
  "gap-y",
  "flex-wrap",
  "no-underline",
  "tabular-nums",
  "break-words",
  "whitespace-pre",
  "min-h",
  "max-w",
  "items-center",
  "justify-between",
  "space-y",
  "rounded",
  "overflow-x-auto",
  "bg-zinc",
  "text-zinc",
  "p-2",
  "p-3",
  "p-6",
  "px-3",
  "py-2",
  "mt-1",
  "mt-2",
  "mt-4",
  "w-full",
  "block",
]);

const SELLER_KEY_A = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const SELLER_KEY_B = privateKeyToAccount(
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
);

test("buildBuyerCard: delivered and not delivered rates match direct pct1 formulas", () => {
  const l1 = { attempts: 10, delivered: 4, inconclusive: 2, awaitingReread: 1 };
  const card = buildBuyerCard({
    yourKey: { total: 1, byChain: [{ chain: "eip155:8453", count: 1 }], days: 30 },
    payments: { paymentCount: 1, verifiedUsdcUnitsSum: "1000000", unverifiedOnChainCount: 0 },
    measurementL1: l1,
  });
  const expected = deliveredRates(l1);
  const { attempts, notHeld, finalOutcome } = expected.denominators;
  assert.equal(card.vet402Measurement.rates.deliveredOfAttemptsPct, expected.deliveredOfAttemptsPct);
  assert.equal(card.vet402Measurement.rates.deliveredOfNotHeldPct, expected.deliveredOfNotHeldPct);
  assert.equal(card.vet402Measurement.rates.deliveredOfFinalOutcomePct, expected.deliveredOfFinalOutcomePct);
  assert.equal(card.vet402Measurement.rates.notDeliveredOfAttemptsPct, pct1(attempts - l1.delivered, attempts));
  assert.equal(card.vet402Measurement.rates.notDeliveredOfNotHeldPct, pct1(notHeld - l1.delivered, notHeld));
  assert.equal(card.vet402Measurement.rates.notDeliveredOfFinalOutcomePct, pct1(finalOutcome - l1.delivered, finalOutcome));
  assert.notEqual(
    card.vet402Measurement.rates.deliveredOfAttemptsPct,
    card.vet402Measurement.rates.deliveredOfFinalOutcomePct,
  );
  const rateKeys = Object.keys(card.vet402Measurement.rates).filter((k) => k.endsWith("Pct"));
  assert.ok(rateKeys.length >= 6);
  assert.equal("deliveredPct" in (card.vet402Measurement.rates as Record<string, unknown>), false);
  assert.equal("notDeliveredPct" in (card.vet402Measurement.rates as Record<string, unknown>), false);
});

test("opsDeliveredRateUnavailableMessage: attempts zero vs all held", () => {
  assert.equal(opsDeliveredRateUnavailableMessage(0, 0), "No purchases on record yet");
  assert.equal(
    opsDeliveredRateUnavailableMessage(5, 0),
    "Denominator is 0 (all attempts are held or awaiting a second read)",
  );
});

test("buildBuyerCard: all held leaves not-held rate unavailable with denominator message", () => {
  const l1 = { attempts: 4, delivered: 0, inconclusive: 4, awaitingReread: 0 };
  const card = buildBuyerCard({
    yourKey: { total: 0, byChain: [], days: 30 },
    payments: { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 },
    measurementL1: l1,
  });
  assert.equal(card.vet402Measurement.rates.deliveredOfNotHeldPct, null);
  assert.equal(
    opsDeliveredRateUnavailableMessage(l1.attempts, card.vet402Measurement.rates.denominators.notHeld),
    "Denominator is 0 (all attempts are held or awaiting a second read)",
  );
  const draft = renderOpsDigestEmailDraft(card);
  assert.match(draft.text, /Denominator is 0 \(all attempts are held or awaiting a second read\)/);
});

test("seller disputes empty copy when truncated", () => {
  const card = buildSellerCard({
    wallet: "0x1",
    revenue: {
      measurementSettledCount: 0,
      measurementSettledUnitsSum: "0",
      reportedVerifiedCount: 0,
      reportedVerifiedUnitsSum: "0",
    },
    l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    disputes: { purchaseIdsChecked: 3, truncated: true, recordsPresent: 0, disputeCount: 0, p2Live: true },
    reputation: { pass: 0, fail: 0, withdrawn: 0, unverified: 0 },
  });
  assert.equal(card.disputes.noRecordsMessage, sellerDisputesNoRecordsMessage(true, 3));
  assert.equal(card.disputes.noRecordsMessage, "No trade disputes among the latest 3 purchases");
  assert.equal(card.disputes.checkedLine, "Checked the latest 3 purchases for this wallet");
  assert.equal(
    card.disputes.truncatedNote,
    sellerDisputesTruncatedNote(true, 3),
  );
  assert.equal(
    card.disputes.truncatedNote,
    "Purchases older than the latest 3 for this wallet were not checked.",
  );
});

test("seller disputes truncated note when records present", () => {
  const card = buildSellerCard({
    wallet: "0x1",
    revenue: {
      measurementSettledCount: 0,
      measurementSettledUnitsSum: "0",
      reportedVerifiedCount: 0,
      reportedVerifiedUnitsSum: "0",
    },
    l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    disputes: { purchaseIdsChecked: 2, truncated: true, recordsPresent: 3, disputeCount: 1, p2Live: true },
    reputation: { pass: 0, fail: 0, withdrawn: 0, unverified: 0 },
  });
  assert.equal(card.disputes.state, "has_data");
  assert.equal(card.disputes.truncatedNote, sellerDisputesTruncatedNote(true, 2));
});

test("seller disputes: E6 record without a dispute stage stays empty", () => {
  const card = buildSellerCard({
    wallet: "0x1",
    revenue: {
      measurementSettledCount: 0,
      measurementSettledUnitsSum: "0",
      reportedVerifiedCount: 0,
      reportedVerifiedUnitsSum: "0",
    },
    l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    disputes: { purchaseIdsChecked: 5, truncated: false, recordsPresent: 1, disputeCount: 0, p2Live: true },
    reputation: { pass: 0, fail: 0, withdrawn: 0, unverified: 0 },
  });
  assert.equal(card.disputes.state, "empty");
  assert.equal(card.disputes.noRecordsMessage, sellerDisputesNoRecordsMessage(false, 5));
});

test("seller disputes: one dispute stage shows has_data", () => {
  const card = buildSellerCard({
    wallet: "0x1",
    revenue: {
      measurementSettledCount: 0,
      measurementSettledUnitsSum: "0",
      reportedVerifiedCount: 0,
      reportedVerifiedUnitsSum: "0",
    },
    l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    disputes: { purchaseIdsChecked: 5, truncated: false, recordsPresent: 2, disputeCount: 1, p2Live: true },
    reputation: { pass: 0, fail: 0, withdrawn: 0, unverified: 0 },
  });
  assert.equal(card.disputes.state, "has_data");
  assert.equal(card.disputes.noRecordsMessage, null);
});

test("loadBuyerCard keeps key usage, reported payments, and vet402 measurement apart", async () => {
  const apiKeyId = "00000000-0000-4000-8000-00000000000a";

  const keySurface = (c: Awaited<ReturnType<typeof loadBuyerCard>>) =>
    JSON.stringify({ yourKey: c.yourKey, days: c.yourKey.days });
  const paySurface = (c: Awaited<ReturnType<typeof loadBuyerCard>>) => JSON.stringify(c.paymentsReported);
  const measureSurface = (c: Awaited<ReturnType<typeof loadBuyerCard>>) => JSON.stringify(c.vet402Measurement);

  let keyArg = "";
  let payArg = "";
  let aggCalled = false;
  const cardKey = await loadBuyerCard(apiKeyId, {
    fetchKeyUsage: async (id) => {
      keyArg = id;
      return { total: 7, byChain: [{ chain: "eip155:8453", count: 7 }] };
    },
    fetchPayments: async (id) => {
      payArg = id;
      return { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 };
    },
    readAggregates: async () => {
      aggCalled = true;
      return { stats: { l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 } } };
    },
  });
  assert.equal(keyArg, apiKeyId);
  assert.equal(payArg, apiKeyId);
  assert.equal(aggCalled, true);
  assert.equal(cardKey.yourKey.state, "has_data");
  assert.equal(cardKey.yourKey.total, 7);
  assert.equal(cardKey.paymentsReported.state, "empty");
  assert.equal(cardKey.paymentsReported.paymentCount, 0);
  assert.equal(cardKey.paymentsReported.verifiedUsdcTotalUnits, "0");
  assert.equal(cardKey.vet402Measurement.state, "empty");
  assert.equal(cardKey.vet402Measurement.attempts, 0);
  assert.doesNotMatch(paySurface(cardKey), /(?:^|[^0-9])7(?:[^0-9]|$)/);
  assert.doesNotMatch(measureSurface(cardKey), /(?:^|[^0-9])7(?:[^0-9]|$)/);

  const cardPay = await loadBuyerCard(apiKeyId, {
    fetchKeyUsage: async () => ({ total: 0, byChain: [] }),
    fetchPayments: async () => ({
      paymentCount: 3,
      verifiedUsdcUnitsSum: "2500000",
      unverifiedOnChainCount: 1,
    }),
    readAggregates: async () => ({
      stats: { l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 } },
    }),
  });
  assert.equal(cardPay.paymentsReported.state, "has_data");
  assert.equal(cardPay.yourKey.total, 0);
  assert.equal(cardPay.vet402Measurement.attempts, 0);
  assert.doesNotMatch(keySurface(cardPay), /(?:^|[^0-9])3(?:[^0-9]|$)/);
  assert.doesNotMatch(keySurface(cardPay), /2500000/);
  assert.doesNotMatch(measureSurface(cardPay), /(?:^|[^0-9])3(?:[^0-9]|$)/);
  assert.doesNotMatch(measureSurface(cardPay), /2500000/);

  const cardMeasure = await loadBuyerCard(apiKeyId, {
    fetchKeyUsage: async () => ({ total: 0, byChain: [] }),
    fetchPayments: async () => ({ paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 }),
    readAggregates: async () => ({
      stats: { l1: { attempts: 10, delivered: 6, inconclusive: 2, awaitingReread: 1 } },
    }),
  });
  assert.equal(cardMeasure.vet402Measurement.state, "has_data");
  assert.equal(cardMeasure.vet402Measurement.attempts, 10);
  assert.equal(cardMeasure.vet402Measurement.delivered, 6);
  assert.equal(cardMeasure.yourKey.total, 0);
  assert.equal(cardMeasure.paymentsReported.paymentCount, 0);
  assert.doesNotMatch(keySurface(cardMeasure), /(?:^|[^0-9])10(?:[^0-9]|$)/);
  assert.doesNotMatch(keySurface(cardMeasure), /(?:^|[^0-9])6(?:[^0-9]|$)/);
  assert.doesNotMatch(paySurface(cardMeasure), /(?:^|[^0-9])10(?:[^0-9]|$)/);
  assert.doesNotMatch(paySurface(cardMeasure), /(?:^|[^0-9])6(?:[^0-9]|$)/);
});

test("sellerDisputesTruncatedNote: fixed copy when not truncated", () => {
  assert.equal(sellerDisputesTruncatedNote(false, 5), null);
  const notTrunc = buildSellerCard({
    wallet: "0x1",
    revenue: {
      measurementSettledCount: 0,
      measurementSettledUnitsSum: "0",
      reportedVerifiedCount: 0,
      reportedVerifiedUnitsSum: "0",
    },
    l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    disputes: { purchaseIdsChecked: 5, truncated: false, recordsPresent: 0, disputeCount: 0, p2Live: true },
    reputation: { pass: 0, fail: 0, withdrawn: 0, unverified: 0 },
  });
  assert.equal(notTrunc.disputes.truncatedNote, null);
});

test("setDisputePurchaseLimitForTests and setSellerOpsLoaderForTests refuse production", () => {
  const env = process.env as NodeJS.ProcessEnv & { NODE_ENV?: string };
  const prev = env.NODE_ENV;
  env.NODE_ENV = "production";
  assert.throws(() => setDisputePurchaseLimitForTests(2), /production/);
  assert.throws(() => setSellerOpsLoaderForTests(null), /production/);
  env.NODE_ENV = prev;
});

test("buildBuyerCard: empty inputs use empty state and null rates", () => {
  const card = buildBuyerCard({
    yourKey: { total: 0, byChain: [], days: 30 },
    payments: { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 },
    measurementL1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
  });
  assert.equal(card.yourKey.state, "empty");
  assert.equal(card.paymentsReported.state, "empty");
  assert.equal(card.vet402Measurement.state, "empty");
  assert.equal(card.vet402Measurement.rates.deliveredOfAttemptsPct, null);
  assert.equal(card.vet402Measurement.rates.deliveredOfNotHeldPct, null);
  assert.equal(card.vet402Measurement.rates.deliveredOfFinalOutcomePct, null);
  for (const msg of [
    card.yourKey.emptyMessage,
    card.paymentsReported.emptyMessage,
    card.vet402Measurement.emptyMessage,
  ]) {
    assert.doesNotMatch(msg, EMPTY_LABEL_BAD, `empty label must stay neutral: ${msg}`);
  }
});

test("verifySellerDashboardAccess: valid payTo signature only", async () => {
  const issued = new Date().toISOString();
  const message = sellerDashboardAccessMessage({ wallet: SELLER_KEY_A.address, issued });
  const signature = await SELLER_KEY_A.signMessage({ message });
  const ok = await verifySellerDashboardAccess({
    kind: "payto_signature",
    wallet: SELLER_KEY_A.address,
    signature,
    issued,
  });
  assert.equal(ok.ok, true);

  const wrongKey = await verifySellerDashboardAccess({
    kind: "payto_signature",
    wallet: SELLER_KEY_A.address,
    signature: await SELLER_KEY_B.signMessage({ message }),
    issued,
  });
  assert.equal(wrongKey.ok, false);

  const wrongWallet = await verifySellerDashboardAccess({
    kind: "payto_signature",
    wallet: SELLER_KEY_B.address,
    signature,
    issued,
  });
  assert.equal(wrongWallet.ok, false);

  const stale = new Date(Date.now() - 11 * 60_000).toISOString();
  const staleSig = await SELLER_KEY_A.signMessage({
    message: sellerDashboardAccessMessage({ wallet: SELLER_KEY_A.address, issued: stale }),
  });
  const outside = await verifySellerDashboardAccess({
    kind: "payto_signature",
    wallet: SELLER_KEY_A.address,
    signature: staleSig,
    issued: stale,
  });
  assert.equal(outside.ok, false);

  const p2Reuse = await verifySellerDashboardAccess({
    kind: "payto_signature",
    wallet: SELLER_KEY_A.address,
    signature: await SELLER_KEY_A.signMessage({
      message: p2PartyAccessMessage({ purchaseId: "x", party: "seller", issued }),
    }),
    issued,
  });
  assert.equal(p2Reuse.ok, false);

  const dns = await verifySellerDashboardAccess({ kind: "host_dns_txt", host: "x.example", txt: "v=1" });
  assert.equal(dns.ok, false);
  assert.equal(dns.reason, "dns_txt_not_implemented");

  const badFmt = await verifySellerDashboardAccess({
    kind: "payto_signature",
    wallet: "not-an-address",
    signature,
    issued,
  });
  assert.equal(badFmt.ok, false);
});

test("loadSellerCard: unverified returns no revenue keys and skips DB loader", async () => {
  let loaderCalls = 0;
  setSellerOpsLoaderForTests(async () => {
    loaderCalls++;
    throw new Error("must not load");
  });
  const out = await loadSellerCard({
    kind: "payto_signature",
    wallet: SELLER_KEY_A.address,
    signature: "0x" + "0".repeat(130),
    issued: new Date().toISOString(),
  });
  setSellerOpsLoaderForTests(null);
  assert.equal(out.ok, false);
  assert.equal(loaderCalls, 0);
  if (!out.ok) {
    assert.equal("revenue" in out, false);
    assert.equal("disputes" in out, false);
    assert.equal("delivered" in out, false);
    assert.equal("reputation" in out, false);
  }
});

test("webhook: SSRF refusals and ops.digest event", () => {
  assert.equal(isSafeWebhookUrl("http://example.com/hook"), false);
  assert.equal(isSafeWebhookUrl("https://10.0.0.1/hook"), false);
  assert.equal(isSafeWebhookUrl("https://192.168.1.1/hook"), false);
  assert.equal(isSafeWebhookUrl("https://169.254.169.254/meta"), false);
  assert.equal(isSafeWebhookUrl("https://localhost/hook"), false);
  assert.equal(isWebhookEvent("ops.digest"), true);
});

test("setWebhookDeliveryForTests refuses production", () => {
  const env = process.env as NodeJS.ProcessEnv & { NODE_ENV?: string };
  const prev = env.NODE_ENV;
  env.NODE_ENV = "production";
  assert.throws(() => setWebhookDeliveryForTests(null), /production/);
  env.NODE_ENV = prev;
});

test("ops email and notify do not perform fetch, import mail, or call sendMail", async () => {
  const card = buildBuyerCard({
    yourKey: { total: 0, byChain: [], days: 30 },
    payments: { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 },
    measurementL1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
  });
  const notifySrc = readFileSync("src/lib/dashboard/ops-notify.ts", "utf8");
  const emailSrc = readFileSync("src/lib/dashboard/ops-email.ts", "utf8");
  assert.doesNotMatch(notifySrc, /sendMail|@\/lib\/mail/);
  assert.doesNotMatch(emailSrc, /sendMail|@\/lib\/mail/);
  const draft = renderOpsDigestEmailDraft(card);
  assert.ok(draft.subject.length > 0);
  assert.ok(draft.text.includes("vet402"));
  const prev = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("fetch must not run");
  };
  setWebhookDeliveryForTests(null);
  await dispatchOpsDigest("00000000-0000-4000-8000-000000000001", card);
  globalThis.fetch = prev;
});

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function forbiddenHyphenCompounds(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(HYPHEN_COMPOUND)) {
    const word = m[0] ?? "";
    if (HYPHEN_ALLOW.has(word)) continue;
    if (word.includes("zinc")) continue;
    if (/^text-/.test(word)) continue;
    if (/^font-/.test(word)) continue;
    if (/^border-/.test(word)) continue;
    if (/^divide-/.test(word)) continue;
    if (/^gap-/.test(word)) continue;
    if (/^sm:/.test(word) || /^md:/.test(word)) continue;
    if (/^p[xytblr]?-/.test(word)) continue;
    if (/^m[xytblr]?-/.test(word)) continue;
    if (/^w-/.test(word) || /^h-/.test(word)) continue;
    if (/^rounded/.test(word)) continue;
    if (/^overflow-/.test(word)) continue;
    if (/^bg-/.test(word)) continue;
    if (/^items-/.test(word) || /^justify-/.test(word)) continue;
    if (/^flex-/.test(word)) continue;
    if (/^space-/.test(word)) continue;
    if (/^dash-/.test(word)) continue;
    if (/^family-name/.test(word)) continue;
    bad.push(word);
  }
  return bad;
}

function publicEnglishSurface(file: string, src: string): string {
  const body = stripLineComments(src);
  const chunks: string[] = [];
  if (file.endsWith(".tsx")) {
    for (const m of body.matchAll(/>([^<>{]+)</g)) {
      const t = (m[1] ?? "").trim();
      if (!t || t.startsWith("{") || /[;{}()]/.test(t)) continue;
      if (/[A-Za-z]/.test(t) && /\s/.test(t)) chunks.push(t);
    }
    for (const m of body.matchAll(/(?:placeholder|title|aria-label)=\{?"([^"]+)"/g)) {
      chunks.push(m[1] ?? "");
    }
  } else {
    for (const m of body.matchAll(/"([^"\n]+)"/g)) {
      const s = m[1] ?? "";
      if (/[a-zA-Z]/.test(s) && /\s/.test(s) && !/^\s*;/.test(s)) chunks.push(s);
    }
    for (const m of body.matchAll(/`([^`\n$]*)`/g)) {
      const s = m[1] ?? "";
      if (/[a-zA-Z]/.test(s) && /\s/.test(s)) chunks.push(s);
    }
    if (file.endsWith("ops-card.ts")) {
      chunks.push(OPS_NOT_DELIVERED_RATE_NOTE, OPS_VET402_L1_MEASUREMENT_LEDE);
      chunks.push(
        opsDeliveredRateUnavailableMessage(0, 0),
        opsDeliveredRateUnavailableMessage(3, 0),
        sellerDisputesNoRecordsMessage(false, 0),
        sellerDisputesNoRecordsMessage(true, 5),
        sellerDisputesTruncatedNote(true, 2) ?? "",
        sellerDisputesTruncatedNote(false, 2) ?? "",
      );
    }
    if (file.endsWith("ops-email.ts")) {
      const draft = renderOpsDigestEmailDraft(
        buildBuyerCard({
          yourKey: { total: 1, byChain: [], days: 30 },
          payments: { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 },
          measurementL1: { attempts: 2, delivered: 1, inconclusive: 1, awaitingReread: 0 },
        }),
      );
      chunks.push(draft.subject, draft.text);
    }
  }
  return chunks.join("\n");
}

test("public English guard on new dashboard ops files", () => {
  const roots = [
    "src/app/dashboard/buyer",
    "src/app/dashboard/seller",
    "src/lib/dashboard/ops-card.ts",
    "src/lib/dashboard/ops-data.ts",
    "src/lib/dashboard/seller-access.ts",
    "src/lib/dashboard/ops-notify.ts",
    "src/lib/dashboard/ops-email.ts",
  ];
  const p3NoReread = new Set([
    "src/lib/dashboard/ops-card.ts",
    "src/lib/dashboard/ops-email.ts",
  ]);
  const files: string[] = [];
  for (const root of roots) {
    if (root.endsWith(".ts")) {
      files.push(root);
      continue;
    }
    for (const name of readdirSync(root)) {
      if (name.endsWith(".tsx") || name.endsWith(".ts")) files.push(join(root, name));
    }
  }
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const surface = publicEnglishSurface(file, src);
    assert.doesNotMatch(surface, FORBIDDEN_PUBLIC_ENGLISH, `${file} must follow public English rules`);
    assert.doesNotMatch(surface, /\b(users|customers)\b.*\bestimat/i, `${file} must not estimate audience size`);
    const badHy = forbiddenHyphenCompounds(surface);
    assert.equal(badHy.length, 0, `${file} must not use new hyphen compounds: ${badHy.join(", ")}`);
    if (
      p3NoReread.has(file) ||
      file.includes("src/app/dashboard/buyer/") ||
      file.includes("src/app/dashboard/seller/")
    ) {
      assert.doesNotMatch(surface, REREAD_IN_PUBLIC, `${file} must not use the old settlement label in public English`);
    }
  }
});
