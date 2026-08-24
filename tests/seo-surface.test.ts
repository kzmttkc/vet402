// ============================================================
// vet402 — SEO / AEO / GEO / LLMO surface lock (2026-08-15).
//
// The public site already had per-page OG, FAQPage, llms.txt, and a sitemap.
// These assertions pin the remaining holes that still leak citations or
// hide the live product from crawlers and answer engines:
//   - the observatory is not in the footer index (so a crawler that only
//     follows the RFC index never finds the measurements)
//   - dashboard pages are indexable
//   - twitter:site is unset (cards cite no account)
//   - no RSS, no llms-full.txt, no well-known alias for llms.txt
//   - Organization sameAs is X-only (GitHub / npm are the other identities)
//   - security.txt still names a personal inbox the rest of the site left
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import sitemap from "@/app/sitemap";
import { pageMetadata } from "@/lib/seo";
import { SUPPORT_EMAIL } from "@/lib/support";
import { SITE_URL } from "@/lib/site-url";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("every public indexable route is in the sitemap", () => {
  const urls = new Set(sitemap().map((e) => e.url));
  for (const path of [
    "/",
    "/docs/api",
    "/accuracy",
    "/leaderboard",
    "/observatory",
    "/observatory/state",
    "/observatory/methodology",
    "/payee",
    "/corrections",
    "/operator-log",
    "/faq",
    "/blog",
    "/signup",
    "/legal/terms",
    "/legal/privacy",
    "/legal/notice",
    "/blog/rss.xml",
  ]) {
    assert.ok(urls.has(`${SITE_URL}${path === "/" ? "/" : path}`), `sitemap missing ${path}`);
  }
  assert.ok(![...urls].some((u) => u.includes("/dashboard")), "dashboard must not be in the sitemap");
});

test("footer index names the observatory and the machine-citation files", () => {
  const footer = read("src/components/site/SiteFooter.tsx");
  assert.ok(footer.includes('href: "/observatory"'), "observatory must be in the RFC index");
  assert.ok(footer.includes('href: "/llms.txt"') || footer.includes('href: "/llms-full.txt"'));
  assert.ok(footer.includes("rss.xml"), "RSS must be linked from a crawlable surface");
});

test("dashboard is noindex", () => {
  const dash = read("src/app/dashboard/layout.tsx");
  assert.ok(/index:\s*false/.test(dash), "dashboard layout must set robots.index false");
});

test("twitter:site is the live handle on every card path", () => {
  const seo = read("src/lib/seo.ts");
  const layout = read("src/app/layout.tsx");
  assert.ok(seo.includes("@vet_402"), "pageMetadata must set twitter.site");
  assert.ok(layout.includes("@vet_402"), "root layout must set twitter.site");
});

test("Organization sameAs includes the other public identities", () => {
  const home = read("src/app/page.tsx");
  const seo = read("src/lib/seo.ts");
  const blob = home + seo;
  assert.ok(blob.includes("https://github.com/kzmttkc/vet402"));
  assert.ok(blob.includes("https://www.npmjs.com/package/@vet402/sdk"));
  assert.ok(blob.includes("https://x.com/vet_402"));
});

test("pageMetadata noindex sets robots index:false, and defaults to indexable", () => {
  const indexed = pageMetadata({ title: "T", description: "D", path: "/x" });
  assert.equal(indexed.robots, undefined, "default pages carry no robots override (indexable)");
  const hidden = pageMetadata({ title: "T", description: "D", path: "/x", noindex: true });
  assert.deepEqual(hidden.robots, { index: false, follow: true });
});

test("agent passport noindexes unregistered ids (no infinite indexable soft-404 space)", () => {
  const src = read("src/app/agent/[agentId]/page.tsx");
  // The passport page must gate indexability on a registered identity, not on
  // integer format — otherwise /agent/{any-integer} is an indexable thin page.
  assert.ok(
    src.includes("noindex: !(await agentHasRegisteredIdentity"),
    "generateMetadata must set noindex when the agent has no registered identity",
  );
});

test("answer-engine crawlers are named in robots.ts", () => {
  const robots = read("src/app/robots.ts");
  for (const ua of [
    "Google-CloudVertexBot",
    "MistralAI-User",
    "YouBot",
    "Applebot",
    "Bingbot",
  ]) {
    assert.ok(robots.includes(`"${ua}"`), `robots.ts must name ${ua}`);
  }
});

test("llms-full.txt is generated from the same FAQ and blog sources the HTML uses", () => {
  const route = read("src/app/llms-full.txt/route.ts");
  assert.ok(route.includes("FAQS"), "must import FAQ data, not a second copy");
  assert.ok(route.includes("getAllPosts") || route.includes("BLOG_POSTS"));
  assert.ok(route.includes("text/plain"));
});

test("RSS is built from the blog module", () => {
  const route = read("src/app/blog/rss.xml/route.ts");
  assert.ok(route.includes("getAllPosts"));
  assert.ok(route.includes("application/rss+xml"));
});

test("well-known llms.txt aliases the canonical file", () => {
  const cfg = read("next.config.ts");
  assert.ok(cfg.includes("/.well-known/llms.txt"));
  assert.ok(cfg.includes("/llms.txt"));
});

test("security.txt names the same support inbox the site uses", () => {
  const txt = read("public/.well-known/security.txt");
  assert.ok(txt.includes(`mailto:${SUPPORT_EMAIL}`), `expected ${SUPPORT_EMAIL}`);
  assert.ok(!txt.includes("kzmttkc314@gmail.com"), "personal inbox must not be the disclosure contact");
});

test("FAQ does not tell a machine that scoring-chain Base is the whole product", () => {
  const faq = read("src/components/site/faq-data.ts");
  assert.ok(/observatory/i.test(faq), "FAQ must mention the observatory when it talks about chains");
});

test("payee lookup carries HowTo JSON-LD for answer engines", () => {
  const payee = read("src/app/payee/page.tsx");
  assert.ok(payee.includes('"HowTo"') || payee.includes("'HowTo'"));
});

test("methodology and API docs carry TechArticle JSON-LD", () => {
  const method = read("src/app/observatory/methodology/page.tsx");
  const docs = read("src/app/docs/api/page.tsx");
  assert.ok(method.includes("TechArticle"));
  assert.ok(docs.includes("TechArticle"));
});

test("public pages go through pageMetadata (or the blog article builder)", () => {
  const pages = [
    "src/app/faq/page.tsx",
    "src/app/accuracy/page.tsx",
    "src/app/observatory/page.tsx",
    "src/app/payee/page.tsx",
    "src/app/docs/api/page.tsx",
    "src/app/blog/page.tsx",
    "src/app/blog/[slug]/page.tsx",
  ];
  for (const p of pages) {
    assert.ok(existsSync(join(ROOT, p)), p);
    const src = read(p);
    assert.ok(
      src.includes("pageMetadata") || src.includes("openGraph"),
      `${p} must set per-page Open Graph`,
    );
  }
});
