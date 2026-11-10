// 2026-11-08 LP audit, findings 1–3 and the first-screen px table.
// The home page must not open on an outage strip, and the 375px stack must
// put the four counts above the purchase card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIVENESS_PUBLIC_SENTENCE,
  freshLivenessCache,
  healthBodyUpdatesBanner,
  livenessBannerMessage,
} from "@/lib/health/banner-message";
import { cardDeliveredLabel, sellerRecordParts } from "@/lib/observatory/home-example";
import { explorerTxUrl, isPublicExplorerTxUrl } from "@/lib/observatory/chains";

const css = readFileSync("src/app/home.module.css", "utf8");
const page = readFileSync("src/app/page.tsx", "utf8");
const banner = readFileSync("src/components/site/StatusBanner.tsx", "utf8");
const chrome = readFileSync("src/components/site/SiteChrome.tsx", "utf8");

test("the public health line is one sentence and names no internal system", () => {
  assert.equal(livenessBannerMessage("ok"), null);
  assert.equal(livenessBannerMessage("rate_limited"), null);
  assert.equal(livenessBannerMessage(undefined), null);
  assert.equal(livenessBannerMessage("degraded"), LIVENESS_PUBLIC_SENTENCE);
  assert.equal(livenessBannerMessage("error"), LIVENESS_PUBLIC_SENTENCE);
  assert.match(LIVENESS_PUBLIC_SENTENCE, /See status\.$/);
  assert.doesNotMatch(LIVENESS_PUBLIC_SENTENCE, /—|–|;|\b(we|our)\b|payee|indexer|upstream/i);
  assert.doesNotMatch(LIVENESS_PUBLIC_SENTENCE, /[“”‘’]/);
});

test("only a real verdict updates the line, including a 503 degraded body", () => {
  assert.equal(healthBodyUpdatesBanner(false, "degraded"), true);
  assert.equal(healthBodyUpdatesBanner(false, "error"), true);
  assert.equal(healthBodyUpdatesBanner(false, "ok"), false);
  assert.equal(healthBodyUpdatesBanner(false, "rate_limited"), false);
  assert.equal(healthBodyUpdatesBanner(false, undefined), false);
  assert.equal(healthBodyUpdatesBanner(true, "rate_limited"), false);
  assert.equal(healthBodyUpdatesBanner(true, undefined), false);
  assert.equal(healthBodyUpdatesBanner(true, ""), false);
  assert.equal(healthBodyUpdatesBanner(true, "ok"), true);
  assert.equal(healthBodyUpdatesBanner(true, "degraded"), true);
  assert.equal(healthBodyUpdatesBanner(true, "error"), true);
});

test("a cached failure sticks only when it is still the current sentence and fresh", () => {
  const now = 1_000_000;
  const ttl = 60_000;
  assert.equal(freshLivenessCache(null, now - 1_000, now, ttl), null);
  assert.equal(freshLivenessCache(LIVENESS_PUBLIC_SENTENCE, now - 1_000, now, ttl), LIVENESS_PUBLIC_SENTENCE);
  assert.equal(freshLivenessCache(LIVENESS_PUBLIC_SENTENCE, now - ttl - 1, now, ttl), undefined);
  assert.equal(
    freshLivenessCache("Upstream indexer degraded — payee lookups may return “not verifiable”.", now - 1_000, now, ttl),
    undefined,
  );
});

test("the home route does not paint the strip, and other routes keep a linked quiet line", () => {
  assert.match(chrome, /variant=\{isHome \? "quiet" : "strip"\}/);
  assert.match(banner, /variant === "quiet"/);
  assert.match(banner, /healthBodyUpdatesBanner/);
  assert.match(banner, /href="\/status"/);
  assert.doesNotMatch(banner, /amber/);
  assert.match(banner, /text-\[0\.8125rem\]/);
  assert.match(page, /HomeLivenessNote/);
  assert.doesNotMatch(page, /Upstream indexer|payee lookups/);
});

test("the first screen stacks text, counts, then the card, and the card meets the caps", () => {
  const hero = css.slice(css.indexOf(".hero {"), css.indexOf(".h1 {"));
  assert.match(hero, /align-items:\s*start/);
  assert.match(hero, /column-gap:\s*72px/);
  assert.match(hero, /padding:\s*72px 0 0/);
  assert.match(css, /grid-area:\s*text/);
  assert.match(css, /grid-area:\s*card/);
  assert.match(css, /grid-area:\s*facts/);
  assert.match(css, /grid-area:\s*note/);
  const mobile = css.slice(css.indexOf("@media (max-width: 960px)"));
  assert.match(mobile, /"text"\s*"note"\s*"facts"\s*"card"/);
  assert.match(mobile, /padding:\s*24px 0 0/);
  assert.match(mobile, /\.actions\s*\{[^}]*margin-top:\s*20px/);
  assert.match(css, /\.record\s*\{[^}]*margin:\s*7px 0 0/s);
  assert.match(css, /\.fact dd\s*\{[^}]*line-height:\s*1\.1/s);
  assert.match(css, /\.fact dd\.factSince\s*\{[^}]*margin:\s*4px 0 0/s);
  assert.match(css, /\.fact dd\.factSince\s*\{[^}]*line-height:\s*1\.3/s);
  assert.match(page, /className=\{s\.heroText\}/);
  assert.match(page, /className=\{s\.heroFacts\}/);
  const textAt = page.indexOf("s.heroText");
  const factsAt = page.indexOf("s.heroFacts");
  const cardAt = page.indexOf("s.record");
  assert.ok(textAt < factsAt && factsAt < cardAt, "source order is text, counts, card");
});

test("a one-call seller row names the sample, and the day phrase does not wrap", () => {
  const small = sellerRecordParts(1, 1, 30);
  assert.equal(small.lead + small.days + small.tail, "Only 1 of 1 paid calls in the last 30 days delivered.");
  assert.equal(small.days, "last 30 days");
  const wide = sellerRecordParts(12, 20, 30);
  assert.equal(wide.lead + wide.days + wide.tail, "12 of 20 paid calls delivered, last 30 days");
  assert.match(css, /\.recordRows div\s*\{[^}]*font-size:\s*0\.9375rem/);
  assert.match(css, /\.nowrap\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(page, /sellerLine\.days/);
  assert.match(page, /className=\{s\.nowrap\}/);
});

test("the headline leading is 1.08", () => {
  const h1 = css.slice(css.indexOf(".h1 {"), css.indexOf(".lede {"));
  assert.match(h1, /line-height:\s*1\.08/);
});

test("the first screen defines x402 and does not say 2xx or lookups", () => {
  assert.match(page, /the ones that ask an agent to pay before they answer/);
  assert.match(page, /seller checks a month/);
  assert.match(page, /href="\/signup"/);
  assert.equal(cardDeliveredLabel({ held: false, delivered: true, httpStatus: 200 }), "Yes");
  assert.equal(cardDeliveredLabel({ held: false, delivered: false, httpStatus: 500 }), "No");
  assert.equal(cardDeliveredLabel({ held: true, delivered: false, httpStatus: 400 }), "held, inconclusive");
  const card = page.slice(page.indexOf("lp-record"), page.indexOf("lp-entries"));
  assert.match(card, /cardDeliveredLabel\(receipt\)/);
  assert.doesNotMatch(card, /yes, 2xx|lookups a month/);
  const lede = page.slice(page.indexOf("s.lede"), page.indexOf("s.actions"));
  assert.doesNotMatch(lede, /—|–|;|\b(we|our)\b/);
});

test("a bad health body and a fresh cache do not skip the next poll", () => {
  assert.match(banner, /if \(!healthBodyUpdatesBanner\(res\.ok, body\?\.status\)\) return/);
  assert.match(banner, /setInterval\(\(\) => load\(true\)/);
  assert.match(banner, /freshLivenessCache/);
  assert.doesNotMatch(banner, /writeCache\(next\)[\s\S]{0,80}healthBodyUpdatesBanner/);
});

test("a transaction link is https on a known explorer host", () => {
  const evm = `0x${"ab".repeat(32)}`;
  const hex = "ab".repeat(32);
  const sol = "1".repeat(87);
  const linked = [
    explorerTxUrl("eip155:8453", evm),
    explorerTxUrl("eip155:137", evm),
    explorerTxUrl("eip155:5042", evm),
    explorerTxUrl("eip155:4217", evm),
    explorerTxUrl("eip155:42220", evm),
    explorerTxUrl("eip155:56", evm),
    explorerTxUrl("eip155:42161", evm),
    explorerTxUrl("eip155:43114", evm),
    explorerTxUrl("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", sol),
    explorerTxUrl("xrpl:0", hex),
    explorerTxUrl("stellar:pubnet", hex),
  ];
  for (const url of linked) assert.equal(isPublicExplorerTxUrl(url), true, String(url));
  assert.equal(isPublicExplorerTxUrl(`http://basescan.org/tx/${evm}`), false);
  assert.equal(isPublicExplorerTxUrl(`https://evil.example/tx/${evm}`), false);
  assert.equal(isPublicExplorerTxUrl(`https://basescan.org.evil.example/tx/${evm}`), false);
  assert.equal(isPublicExplorerTxUrl("javascript:alert(1)"), false);
  assert.equal(isPublicExplorerTxUrl(null), false);
  assert.equal((page.match(/isPublicExplorerTxUrl\(/g) ?? []).length, 1);
});

test("the machine-readable description matches the page metadata, and paid prices are visible when offered", () => {
  assert.match(page, /description: String\(metadata\.description\)/);
  assert.match(
    page,
    /description:\n {4}"vet402 checks an x402 seller before your AI agent pays, caps spending, and publishes what each seller delivered\. Settlement assets include USDC\.",/,
  );
  assert.match(page, /Pro is \$\{BILLING_PLANS\.pro\.monthlyUsd\} a month\. Scale is \$\{BILLING_PLANS\.scale\.monthlyUsd\} a month\./);
  assert.match(page, /isStripeConfigured\(\) \?/);
});

test("a missing purchase card leaves one text column", () => {
  const hero = css.slice(css.indexOf(".hero {"), css.indexOf(".hero:has(.record)"));
  assert.match(hero, /minmax\(0,\s*40rem\)/);
  assert.match(hero, /"text"\s*"note"\s*"facts"/);
  assert.match(css, /\.hero:has\(\.record\)\s*\{[^}]*minmax\(0,\s*1fr\) minmax\(0,\s*440px\)/);
});

test("the purchase card does not fade in from off-screen", () => {
  assert.match(css, /animation:\s*lpRise 180ms ease-out both/);
  assert.doesNotMatch(css, /opacity:\s*0\.001/);
  assert.doesNotMatch(css, /translateY/);
});

test("CC BY links to the license, and sellers stay in the footer", () => {
  assert.match(page, /href="https:\/\/creativecommons.org\/licenses\/by\/4.0\/"/);
  assert.match(page, /label: "Sellers", href: "\/sellers"/);
});

test("footer type, link underlines, and the quiet button border stay grey", () => {
  assert.match(css, /\.foot\s*\{[^}]*font-size:\s*1rem/);
  assert.match(css, /\.footLinks a\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.footNote\s*\{[^}]*font-size:\s*0\.875rem/);
  assert.match(css, /text-decoration-color:\s*var\(--lp-ink-4\)/);
  assert.match(css, /border-color:\s*rgba\(255,\s*255,\s*255,\s*0\.28\)/);
  const bad: string[] = [];
  for (const m of css.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    if (!(m[1] === m[2] && m[2] === m[3])) bad.push(m[0]);
  }
  assert.deepEqual(bad, []);
});

test("the home page sets Martian and Fragment next to Inter", () => {
  assert.match(page, /\$\{inter\.variable\} \$\{martianMono\.variable\} \$\{fragmentMono\.variable\}/);
  const fonts = readFileSync("src/app/fonts.ts", "utf8");
  assert.match(fonts, /variable:\s*"--font-martian"/);
  assert.match(fonts, /variable:\s*"--font-fragment"/);
  assert.match(fonts, /preload:\s*false/);
  assert.match(fonts, /adjustFontFallback:\s*false/);
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /martianMono\.variable/);
  assert.match(layout, /fragmentMono\.variable/);
});

test("entry cards use the links grid and sections open with less padding", () => {
  assert.doesNotMatch(page, /style=\{\{ margin:/);
  assert.match(page, /const ENTRY_CARDS/);
  assert.match(page, /entry_before_pay/);
  assert.match(css, /\.section\s*\{[^}]*padding:\s*80px 0 0/);
  assert.match(css, /\.links\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.section \{\s*padding-top:\s*56px;/);
});

test("the live counts still say what delivered means (2026-11-10, kept when the middle became three entries)", () => {
  assert.match(page, /Delivered means a non-empty 2xx\. A 4xx is inconclusive, because it can come from the shape of/);
});
