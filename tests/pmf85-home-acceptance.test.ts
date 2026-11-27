import { apiDocsPageText } from "./lib/api-docs-source";
import { BILLING_PLANS } from "@/lib/billing/plans";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const read = (p: string) => readFileSync(p, "utf8");

const SAFE_RE = /\bsafe(ly)?\b/i;
const SCORE_LOOKUPS = /score lookups/i;
const SUPERLATIVE_RE = /(?:^|[^#\w])(best|#1|guaranteed?)(?:[^#\w]|$)/i;
const WE_OUR_RE = /\b(we|our|us)\b/i;
const DASH_RE = /[—–]|&mdash;|&ndash;/;
const PROSE_SEMICOLON_RE = /[a-zA-Z][^;\n]*;/;

const HOME_RENDERED = [
  "src/app/page.tsx",
  ...readdirSync("src/components/site/home")
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join("src/components/site/home", f)),
  "src/components/site/SiteHeader.tsx",
  "src/components/site/SiteFooter.tsx",
];

/** JSX text nodes and labelled string literals that ship as user-facing English. */
function renderedEnglishFromSource(tsx: string): string {
  const noComments = tsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const chunks: string[] = [];
  for (const m of noComments.matchAll(
    /(?:title|sentence|linkLabel|description|label|aria-label|placeholder):\s*"([^"]+)"/g,
  )) {
    if (/[a-zA-Z]/.test(m[1]!)) chunks.push(m[1]!);
  }
  const jsx = noComments.includes("return (") ? noComments.slice(noComments.indexOf("return (")) : noComments;
  for (const m of jsx.matchAll(/>([^<>{}\n]+)</g)) {
    const t = m[1]!.replace(/\s+/g, " ").trim();
    if (t && /[a-zA-Z]/.test(t)) chunks.push(t);
  }
  return [...new Set(chunks)].join("\n");
}

function assertPublicEnglishRules(text: string, label: string) {
  for (const line of text.split("\n").filter((l) => l.trim())) {
    const scrubbed = line.replace(/\ben-US\b/gi, "");
    const noDisclaimer = scrubbed.replace(/not a guarantee/gi, "");
    assert.doesNotMatch(noDisclaimer, SUPERLATIVE_RE, `${label}: superlative in ${line}`);
    assert.doesNotMatch(scrubbed, WE_OUR_RE, `${label}: we/our/us in ${line}`);
    assert.doesNotMatch(scrubbed, DASH_RE, `${label}: dash in ${line}`);
    const noEntities = scrubbed.replace(/&[a-zA-Z]+;|&#\d+;/g, " ");
    assert.doesNotMatch(noEntities, PROSE_SEMICOLON_RE, `${label}: semicolon in ${line}`);
  }
}

test("A-2/G-1: home H1, sub, connect lead, and no safe/safely on key surfaces", () => {
  const page = read("src/app/page.tsx");
  assert.match(page, /Know if an x402 seller delivers before your agent pays\./);
  assert.match(
    page,
    /vet402 pays x402 sellers with its own money and publishes what came back\. Paste a URL to see the record\.[\s\S]*These are measurements, not a guarantee\./,
  );
  assert.match(read("src/lib/connect/snippets.ts"), /Both sides read the same purchase records\./);
  assert.doesNotMatch(read("src/app/signup/layout.tsx"), SAFE_RE);
  assert.doesNotMatch(read("src/lib/seo.ts"), SAFE_RE);
  assert.doesNotMatch(read("src/app/layout.tsx"), SAFE_RE);
  assert.doesNotMatch(read("src/app/opengraph-image.alt.txt"), SAFE_RE);
  assert.doesNotMatch(read("src/lib/connect/snippets.ts"), SAFE_RE);
  assert.doesNotMatch(read("src/app/connect/page.tsx"), SAFE_RE);
  for (const f of HOME_RENDERED) {
    assert.doesNotMatch(read(f), SAFE_RE, f);
  }
});

test("A-1: monthly quota copy uses score lookups, not seller checks", () => {
  assert.match(read("src/app/signup/layout.tsx"), SCORE_LOOKUPS);
  assert.match(read("src/components/site/faq-data.ts"), SCORE_LOOKUPS);
  assert.match(read("src/app/page.tsx"), SCORE_LOOKUPS);
  assert.match(apiDocsPageText(), SCORE_LOOKUPS);
  assert.match(read("src/app/signup/page.tsx"), /FREE_MONTHLY_SCORE_LOOKUPS.*score lookups/);
  assert.match(read("src/app/signup/layout.tsx"), /BILLING_PLANS\.free\.monthlyLimit/);
});

test("A-1b: pricing surfaces name the monthly quota score lookups", () => {
  const SELLER_CHECK_MONTH = /seller checks?\s*\/\s*month|seller checks a month/i;
  for (const f of [
    "src/app/page.tsx",
    "src/app/pricing/page.tsx",
    "src/app/signup/page.tsx",
    "src/components/site/PricingSection.tsx",
  ]) {
    assert.match(read(f), SCORE_LOOKUPS, f);
    assert.doesNotMatch(read(f), SELLER_CHECK_MONTH, f);
  }
  const apiDocs = apiDocsPageText();
  assert.match(apiDocs, SCORE_LOOKUPS, "docs/api");
  assert.doesNotMatch(apiDocs, SELLER_CHECK_MONTH, "docs/api");
});

test("item 3: hero lede states not a guarantee without a link in the hero column", () => {
  const page = read("src/app/page.tsx");
  const heroStart = page.indexOf('className={s.heroText}');
  const heroEnd = page.indexOf("</div>", page.indexOf("<PasteCheck", heroStart));
  const hero = page.slice(heroStart, heroEnd);
  assert.match(hero, /not a guarantee/);
  assert.doesNotMatch(hero, /href="\/x402\/check-a-seller"/);
});

test("C-1: hero text column has no marketing link before PasteCheck", () => {
  const page = read("src/app/page.tsx");
  const heroStart = page.indexOf('className={s.heroText}');
  const heroEnd = page.indexOf("</div>", page.indexOf("<PasteCheck", heroStart));
  const hero = page.slice(heroStart, heroEnd);
  const h1 = hero.indexOf("<h1");
  const paste = hero.indexOf("<PasteCheck", h1);
  assert.ok(paste > h1);
  assert.doesNotMatch(hero, /<Link href=/);
});

test("E-1: SiteHeader has five entries, full-width mobile panel, and menu a11y hooks", () => {
  const header = read("src/components/site/SiteHeader.tsx");
  assert.match(header, /Check a seller/);
  assert.match(header, /Observatory/);
  assert.match(header, /Docs/);
  assert.match(header, /Dashboard/);
  assert.match(header, /Get API key/);
  assert.match(header, /aria-expanded=\{mobileOpen\}/);
  assert.match(header, /aria-label="Site menu"/);
  assert.match(header, /aria-hidden="true"[^>]*>Close</);
  assert.match(header, /absolute left-0 right-0 top-full/);
  assert.match(header, /relative px-4/);
  assert.match(header, /onKeyDown=\{onEscape\}/);
  assert.match(header, /firstLink\?\.focus\(\)/);
  assert.match(read("src/components/site/SiteChrome.tsx"), /isHome \? null : <SiteHeader/);
  assert.match(read("src/app/page.tsx"), /<header className=\{s\.wrap\}/);
});

test("E-1b: 375px width uses late hero rules so H1, primary button, and URL field stay reachable", () => {
  const css = read("src/app/home.module.css");
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /\.h1\s*\{[^}]*font-size:\s*clamp\(1\.75rem/);
  const midActions = css.indexOf("@media (max-width: 960px)");
  const narrowActions16 = css.lastIndexOf(".actions {\n    margin-top: 16px;");
  const midActions20 = css.indexOf(".actions {\n    margin-top: 20px;", midActions);
  assert.ok(narrowActions16 > midActions20, "390px actions 16px must follow the 960px 20px rule");
  const pasteBase = css.indexOf(".pasteForm {\n  margin: 0;\n}");
  const pasteNarrow = css.lastIndexOf(".pasteForm {\n    margin-top: 12px;\n  }");
  assert.ok(pasteNarrow > pasteBase, "390px pasteForm 12px must follow the base margin reset");
  assert.match(css, /\.pasteInput\s*\{[^}]*min-height:\s*46px/);
  assert.match(css, /\.btn,\s*\n\.btnQuiet\s*\{[^}]*min-height:\s*46px/);
});

test("E-2: 404 h1 names 404, not Status report", () => {
  const nf = read("src/app/not-found.tsx");
  assert.match(nf, /<h1[^>]*>404/);
  assert.doesNotMatch(nf, /Status report/);
});

test("E-3: home links to /pricing instead of embedding PricingSection", () => {
  const page = read("src/app/page.tsx");
  assert.doesNotMatch(page, /<PricingSection/);
  assert.match(page, /href="\/pricing"/);
  assert.doesNotMatch(page, /Pro is \$\{BILLING_PLANS\.pro\.monthlyUsd\} a month/);
});

test("E-4: TableScroll omits the hint row when column count is zero", () => {
  const ts = read("src/components/site/TableScroll.tsx");
  assert.match(ts, /hiddenColumns > 0/);
  assert.doesNotMatch(ts, /hidden=\{hiddenColumns === 0\}/);
});

test("G-2a: SiteFooter disclaimer is for agent and service operators, not B2B API use", () => {
  const footer = read("src/components/site/SiteFooter.tsx");
  assert.doesNotMatch(footer, /B2B API use/);
  assert.match(footer, /for agent and service operators/);
});

test("G-2: SiteFooter offers Privacy choices with the privacy-choices anchor", async () => {
  const footer = read("src/components/site/SiteFooter.tsx");
  assert.match(footer, /Privacy choices/);
  assert.match(footer, /\/legal\/privacy#privacy-choices/);
  const prev = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  try {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SiteFooter } = await import("@/components/site/SiteFooter");
    const html = renderToStaticMarkup(createElement(SiteFooter, { pathname: "/" }));
    assert.match(html, />Privacy choices</);
    assert.match(html, /\/legal\/privacy#privacy-choices/);
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
    else process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID = prev;
  }
});

test("G6 and item 12: home, connect, and shared chrome follow public English rules, paste URL input remains", () => {
  const connect = read("src/app/connect/page.tsx") + read("src/lib/connect/snippets.ts");
  const connectNoDisclaimer = connect.replace(/not a guarantee/gi, "");
  assert.doesNotMatch(connectNoDisclaimer, SUPERLATIVE_RE);
  for (const f of HOME_RENDERED) {
    assertPublicEnglishRules(renderedEnglishFromSource(read(f)), f);
  }
  assert.match(read("src/components/site/home/PasteCheck.tsx"), /type="url"/);
  assert.match(read("src/components/site/home/PasteCheck.tsx"), /name="url"/);
});

test("B-1: PasteCheck same-host and none states in source", () => {
  const paste = read("src/components/site/home/PasteCheck.tsx");
  assert.match(paste, /same_host_listings/);
  assert.match(paste, /This host has/);
  assert.match(paste, /\? "listing" : "listings"/);
  assert.match(paste, /home_paste_submit/);
  assert.match(paste, /home_result_state/);
  assert.match(paste, /home_snippet_copy/);
  assert.match(paste, /vet402 has no purchase record for this URL\./);
  assert.match(paste, /\/api\/v1\/diagnose\?url=/);
  assert.match(paste, /pathSegments/);
});