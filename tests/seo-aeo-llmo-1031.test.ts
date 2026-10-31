// 2026-10-31 SEO / AEO / LLMO: the gaps measured on production that day, pinned so that undoing a fix turns red.
//
// Measured with curl -sL on every URL of /sitemap.xml and a 40-page sample of /sitemap-observatory.xml:
//   1. /blog/rss.xml sat in the page sitemap. It is a feed, not a page, so it has no description, canonical or OG.
//   2. 6 of 40 /observatory/e/{id} pages had no title, description, canonical or OG in <head>. Next.js streams
//      metadata into <body> for any user agent outside its HTML-limited list, and that list does not name curl,
//      GPTBot, ClaudeBot or PerplexityBot. Those readers do not run JavaScript.
//   3. /docs/mcp, /decisions and /operations carried no WebAPI / WebPage node.
//   4. The home page dated a past event as "September 2026", which the judge-face check reads as a stale month.
//   5. /docs/api explained the vouch_ key prefix as "vet402's former name (Vouch)", which the outward-name scan
//      flags. The fact stays; the wording now matches the allowed "was called Vouch until August 2026" form.
//   6. /docs/api opened with a table of contents and no sentence saying what vet402 is or how to check a seller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nextConfig from "../next.config";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import { API_DOCS_ANSWER } from "@/lib/docs/api-page-text";
import { webApiJsonLd } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MONTH_YEAR = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (20\d{2})\b/g;

test("metadata lands in <head> for every user agent, including curl and AI crawlers", () => {
  const re = nextConfig.htmlLimitedBots;
  assert.ok(re instanceof RegExp, "htmlLimitedBots must be set");
  for (const ua of [
    "curl/8.7.1",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "",
  ]) {
    assert.ok(re.test(ua), `streams metadata into <body> for: ${ua || "(empty UA)"}`);
  }
});

test("the page sitemap lists pages only; the RSS feed stays linked from <head> and the footer", () => {
  const urls = sitemap().map((e) => e.url);
  assert.equal(urls.some((u) => /\.(xml|txt|json|csv|yaml)$/.test(u)), false, urls.join("\n"));
  assert.equal(new Set(urls).size, urls.length, "duplicate sitemap URL");
  for (const u of urls) assert.ok(u.startsWith(`${SITE_URL}/`), u);
  assert.match(read("src/lib/seo.ts"), /"application\/rss\+xml": `\$\{SITE_URL\}\/blog\/rss\.xml`/);
  assert.ok(read("src/components/site/SiteFooter.tsx").includes("rss.xml"));
});

test("robots lets the answer-engine crawlers read the site and points at both sitemaps", () => {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
  for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "OAI-SearchBot", "Bingbot"]) {
    const rule = rules.find((x) => (Array.isArray(x.userAgent) ? x.userAgent : [x.userAgent]).includes(bot));
    assert.ok(rule, `${bot} has no rule`);
    const allow = Array.isArray(rule.allow) ? rule.allow : [rule.allow];
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    assert.ok(allow.includes("/"), `${bot} is not allowed /`);
    assert.equal(disallow.includes("/"), false, `${bot} is disallowed /`);
  }
  const maps = Array.isArray(r.sitemap) ? r.sitemap : [r.sitemap];
  assert.ok(maps.includes(`${SITE_URL}/sitemap.xml`));
  assert.ok(maps.includes(`${SITE_URL}/sitemap-observatory.xml`));
});

test("llms.txt links the hosted MCP server next to the API reference", () => {
  const llms = read("public/llms.txt");
  const primary = llms.slice(llms.indexOf("## Primary"), llms.indexOf("\n## ", llms.indexOf("## Primary") + 3));
  assert.match(primary, /^- https:\/\/vet402\.com\/docs\/mcp\. .+/m);
  assert.ok(primary.includes("https://vet402.com/docs/api"));
  assert.ok(primary.includes("https://vet402.com/observatory/state"));
  assert.ok(primary.includes("https://vet402.com/openapi.yaml"));
  const line = primary.split("\n").find((l) => l.startsWith("- https://vet402.com/docs/mcp"))!;
  assert.equal(line.includes("—"), false, "no em dash in new copy");
  assert.equal(/\bwe\b/i.test(line), false);
});

test("/docs/mcp carries a WebAPI node pointing at its own page", () => {
  const src = read("src/app/docs/mcp/page.tsx");
  assert.match(src, /webApiJsonLd\(\{/);
  assert.match(src, /path: "\/docs\/mcp"/);
  assert.match(src, /safeJsonLd\(webApi\)/);
  const node = webApiJsonLd({ name: "n", description: "d", path: "/docs/mcp", documentation: "/docs/mcp" });
  assert.equal(node.url, `${SITE_URL}/docs/mcp`);
  assert.equal(node.documentation, `${SITE_URL}/docs/mcp`);
  const api = webApiJsonLd({ name: "n", description: "d" });
  assert.equal(api.url, `${SITE_URL}/docs/api`);
  assert.equal(api.documentation, `${SITE_URL}/openapi.yaml`);
});

test("/decisions and /operations carry BreadcrumbList and WebPage nodes", () => {
  for (const [file, path] of [
    ["src/app/decisions/page.tsx", "/decisions"],
    ["src/app/operations/page.tsx", "/operations"],
  ] as const) {
    const src = read(file);
    assert.match(src, /breadcrumbJsonLd\(\[/, file);
    assert.match(src, /webPageJsonLd\(\{/, file);
    assert.ok(src.includes(`path: "${path}"`), `${file} path`);
    assert.match(src, /type="application\/ld\+json"/, file);
    assert.match(src, /nonce=\{nonce\}/, file);
  }
});

test("the home page names no past month as a month-and-year (judge-face past_month_mentions)", () => {
  // Tags out and whitespace folded, as the judge-face check reads the rendered text.
  const src = read("src/app/page.tsx").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // The same exclusion the judge-face check keeps: the cited report title "Agentic Payments from the Ground Up, July 2026".
  const hits = [...src.matchAll(MONTH_YEAR)].filter((m) => !/Ground Up\s*,?\s*$/.test(src.slice(Math.max(0, m.index! - 40), m.index)));
  assert.deepEqual(
    hits.map((m) => m[0]),
    [],
  );
  assert.match(src, /returned HTTP 500 on some checks before 2026-09-29/);
});

test("/docs/api explains the vouch_ prefix with the allowed history wording", () => {
  const src = read("src/app/docs/api/page.tsx");
  assert.equal(src.includes("former\n            name (Vouch)"), false);
  assert.equal(/former name \(Vouch\)/.test(src.replace(/\s+/g, " ")), false);
  assert.match(src.replace(/\s+/g, " "), /the product was called Vouch until August 2026\), so existing keys and configs keep working\./);
});

test("/docs/api opens with a plain answer: what vet402 is and how to check a seller before paying", () => {
  const sentences = API_DOCS_ANSWER.split(/(?<=\.)\s+/).filter(Boolean);
  assert.ok(sentences.length >= 1 && sentences.length <= 2, API_DOCS_ANSWER);
  assert.match(API_DOCS_ANSWER, /^vet402 buys from x402 APIs itself and publishes what came back/);
  assert.match(API_DOCS_ANSWER, /check a seller before it pays/);
  assert.match(API_DOCS_ANSWER, /resource_id/);
  assert.match(API_DOCS_ANSWER, /ALLOW, WARN or BLOCK/);
  assert.equal(API_DOCS_ANSWER.includes("—"), false, "no em dash");
  assert.equal(/\bwe\b/i.test(API_DOCS_ANSWER), false, "no we");
  const src = read("src/app/docs/api/page.tsx");
  const answerAt = src.indexOf("{API_DOCS_ANSWER}");
  assert.ok(answerAt > 0, "API_DOCS_ANSWER is not rendered");
  assert.ok(answerAt < src.indexOf('id="quickstart"'), "the answer must come before Quickstart");
  assert.ok(answerAt > src.indexOf('<h1 className="doc-title'), "the answer comes after the title");
});

test("chain guide descriptions say what vet402 measures there, from the lead sentences", () => {
  for (const c of GUIDE_CHAINS) {
    assert.ok(c.description.startsWith(c.lead[0]), `${c.slug}: ${c.description}`);
    assert.ok(c.description.includes(c.lead[1]), `${c.slug}: ${c.description}`);
    assert.ok(c.description.includes(`CAIP-2 ${c.caip2}.`), c.slug);
    assert.ok(c.description.length >= 70 && c.description.length <= 160, `${c.slug} is ${c.description.length}`);
    assert.equal(c.description.includes("—"), false, c.slug);
  }
});
