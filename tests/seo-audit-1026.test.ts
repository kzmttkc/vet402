// 2026-10-26 SEO 点検の直しを、戻すと赤になる形で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PUBLIC_READ_ALLOWS } from "@/app/robots";
import { keylessRatesSentence } from "@/lib/api/keyless-limits";
import { FAQS } from "@/components/site/faq-data";
import { SUPPORTED_CHAINS } from "@/components/site/supported-chains-data";
import {
  CHAINS_HUB,
  CHECK_SELLER,
  LLM_QUESTIONS,
  STABLECOIN_PAYMENTS,
  WHAT_IS_X402_LEAD,
  WHAT_IS_X402_SEO,
  measuredChainsSentence,
} from "@/components/site/x402-answers";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import { ETHONLINE_OG_IMAGE_ALT, OG_IMAGE_ALT, pageMetadata, webApiJsonLd } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function quotedDescription(file: string): string {
  const start = read(file).indexOf("export const metadata");
  assert.ok(start >= 0, file);
  const matched = read(file).slice(start, start + 900).match(/description:\s*\n?\s*"([^"]*)"/);
  assert.ok(matched, `${file} description`);
  return matched[1];
}

test("開けた 6 本の読み取りは応答に X-Robots-Tag: noindex を付ける", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  const savedApp = process.env.APP_ENV;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  process.env.APP_ENV = "test";
  try {
    const [{ GET: state }, { GET: history }, { GET: l1 }, { GET: l0 }, { GET: accuracy }, { GET: census }] =
      await Promise.all([
        import("@/app/api/v1/observatory/state/route"),
        import("@/app/api/v1/observatory/history/route"),
        import("@/app/api/v1/observatory/export.csv/route"),
        import("@/app/api/v1/observatory/l0/export.csv/route"),
        import("@/app/api/v1/accuracy/route"),
        import("@/app/api/v1/census/summary/route"),
      ]);
    const call = (path: string, ip: string, get: (req: NextRequest) => Promise<Response> | Response) =>
      Promise.resolve(get(new NextRequest(`http://localhost${path}`, { headers: { "x-real-ip": ip } })));
    const cases: Array<[string, (req: NextRequest) => Promise<Response> | Response]> = [
      ["/api/v1/observatory/state", state],
      ["/api/v1/observatory/history", history],
      ["/api/v1/observatory/export.csv", l1],
      ["/api/v1/observatory/l0/export.csv", l0],
      ["/api/v1/accuracy", accuracy],
      ["/api/v1/census/summary", census],
    ];
    for (const [i, [path, get]] of cases.entries()) {
      const res = await call(path, `198.51.100.${10 + i}`, get);
      assert.equal(res.headers.get("x-robots-tag"), "noindex", `${path} ${res.status}`);
    }
    const badDays = await call("/api/v1/observatory/history?days=30.0", "198.51.100.20", history);
    assert.equal(badDays.status, 400);
    assert.equal(badDays.headers.get("x-robots-tag"), "noindex");
    const badWindow = await call("/api/v1/census/summary?window=1d", "198.51.100.21", census);
    assert.equal(badWindow.status, 400);
    assert.equal(badWindow.headers.get("x-robots-tag"), "noindex");
    for (const path of PUBLIC_READ_ALLOWS) assert.ok(cases.some(([p]) => p === path), path);
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
    if (savedApp === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedApp;
  }
});

test("history の days は DB を読む前に正規化し、無指定は 30 のまま", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  const savedApp = process.env.APP_ENV;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  process.env.APP_ENV = "test";
  try {
    const { GET } = await import("@/app/api/v1/observatory/history/route");
    const call = (search: string, ip: string) =>
      GET(new NextRequest(`http://localhost/api/v1/observatory/history${search}`, { headers: { "x-real-ip": ip } }));
    const padded = await call("?days=030", "198.51.100.30");
    assert.equal(padded.status, 308);
    assert.match(padded.headers.get("location") ?? "", /\?days=30$/);
    const wide = await call("?days=999999999", "198.51.100.31");
    assert.equal(wide.status, 308);
    assert.match(wide.headers.get("location") ?? "", /\?days=366$/);
    const zero = await call("?days=0", "198.51.100.32");
    assert.equal(zero.status, 308);
    assert.match(zero.headers.get("location") ?? "", /\?days=1$/);
    const missing = await call("", "198.51.100.33");
    assert.notEqual(missing.status, 308);
    assert.equal(missing.headers.get("x-robots-tag"), "noindex");
    const canonical = await call("?days=30", "198.51.100.34");
    assert.notEqual(canonical.status, 308);
    assert.notEqual(canonical.status, 400);
    const route = read("src/app/api/v1/observatory/history/route.ts");
    const canonicalAt = route.indexOf("daysParam !== String(days)");
    const readAt = route.indexOf("getDailyMetricsHistory(days)");
    assert.ok(canonicalAt > 0 && readAt > canonicalAt);
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
    if (savedApp === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedApp;
  }
});

test("公開の meta description は 160 字以内で、トップは USDC だけとは読まない", () => {
  const api = `Decision API for x402 agent payments. ${keylessRatesSentence()}`;
  assert.match(
    read("src/app/docs/api/page.tsx"),
    /const API_BLURB = `Decision API for x402 agent payments\. \$\{keylessRatesSentence\(\)\}`;/,
  );
  const pages: Array<[string, string]> = [
    ["home", quotedDescription("src/app/page.tsx")],
    ["observatory", quotedDescription("src/app/observatory/page.tsx")],
    ["state", quotedDescription("src/app/observatory/state/page.tsx")],
    ["api", api],
    ["what-is", WHAT_IS_X402_SEO],
    ["stablecoin", STABLECOIN_PAYMENTS.description],
    ["check", CHECK_SELLER.description],
    ["chains", CHAINS_HUB.description],
    ...GUIDE_CHAINS.map((c): [string, string] => [c.slug, c.description]),
    ...LLM_QUESTIONS.map((q): [string, string] => [q.path, q.description]),
  ];
  for (const [name, text] of pages) {
    assert.ok(text.length <= 160, `${name} is ${text.length}: ${text}`);
  }
  const home = quotedDescription("src/app/page.tsx");
  assert.equal(home.includes("pays in USDC"), false);
  assert.match(home, /include USDC/);
  assert.equal(read("src/app/layout.tsx").includes("pays in USDC"), false);
});

test("impact は 2 つ目の Dataset を出さず、state の Dataset を isBasedOn する", () => {
  const src = read("src/app/impact/page.tsx");
  assert.equal(src.includes("datasetJsonLd"), false);
  assert.equal(src.includes("impact figures"), false);
  assert.match(src, /isBasedOn: `\$\{SITE_URL\}\/observatory\/state`/);
  assert.match(src, /citeAs\("observatory"/);
});

test("WebAPI の url は /docs/api、仕様は /openapi.yaml", () => {
  const node = webApiJsonLd({ name: "vet402 API", description: "d" });
  assert.equal(node.url, `${SITE_URL}/docs/api`);
  assert.equal(node.documentation, `${SITE_URL}/openapi.yaml`);
  assert.equal(String(node.url).endsWith("/api/v1"), false);
});

test("チェーン頁の見出しと CAIP-2 はレーンの事実から作る", () => {
  const bySlug = Object.fromEntries(GUIDE_CHAINS.map((c) => [c.slug, c]));
  assert.equal(bySlug.base.headline, "x402 payments on Base (USDC)");
  assert.equal(bySlug.base.caip2, "eip155:8453");
  assert.match(bySlug.base.tie, /EIP-3009/);
  assert.equal(bySlug.solana.headline, "x402 payments on Solana (USDC)");
  assert.match(bySlug.solana.tie, /memo/);
  assert.equal(bySlug.tempo.headline, "Agent payments on Tempo over MPP (USDC.e)");
  assert.equal(bySlug.tempo.caip2, "eip155:4217");
  assert.match(bySlug.tempo.tie, /TIP-20/);
  assert.match(bySlug.tempo.lead[0], /Machine Payments Protocol/);
  assert.equal(bySlug.tempo.headline.includes(", not"), false);
  assert.equal(bySlug.xrpl.headline, "x402 payments on XRPL (RLUSD)");
  assert.match(bySlug.xrpl.tie, /hash of the signed blob/);
  assert.match(bySlug["arbitrum-one"].tie, /EIP-3009/);
  assert.equal(bySlug["arbitrum-one"].caip2, "eip155:42161");
  assert.equal(bySlug["bnb-chain"].headline, "x402 payments on BNB Chain (USD1)");
  assert.equal(bySlug["bnb-chain"].caip2, "eip155:56");
  assert.equal(bySlug.stellar.caip2, "stellar:pubnet");
  assert.match(bySlug.stellar.tie, /payer, the payee, the amount, and the asset/);
  const lanes = SUPPORTED_CHAINS.filter((row) => row.kind === "lane").map((row) => row.chain);
  assert.deepEqual(
    lanes.filter((chain) => ["stellar:pubnet", "Arbitrum", "BSC"].includes(chain)),
    ["stellar:pubnet", "Arbitrum", "BSC"],
  );
});

test("Which chains の先頭の文は SUPPORTED_CHAINS から作り、Tempo は MPP と書く", () => {
  const lead = measuredChainsSentence();
  assert.equal(CHAINS_HUB.lead[0], lead);
  assert.equal(CHAINS_HUB.question.startsWith("Which chains"), true);
  assert.match(lead, /Tempo \(USDC\.e over MPP, the Machine Payments Protocol\)/);
  assert.match(lead, /Arbitrum One \(USDC over x402\)/);
  assert.match(lead, /BNB Chain \(USD1 over x402\)/);
  assert.match(lead, /Stellar \(USDC over x402\)/);
  assert.ok(read("public/llms.txt").includes(lead));
  assert.equal(CHAINS_HUB.h1, "x402 and MPP payments by chain");
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("x402 payments for AI agents はトップの頁だけが使う", () => {
  const phrase = "x402 payments for AI agents";
  const allowed = new Set(["src/app/page.tsx"]);
  const hits = sourceFiles(join(ROOT, "src"))
    .filter((path) => readFileSync(path, "utf8").includes(phrase))
    .map((path) => path.slice(ROOT.length + 1));
  assert.deepEqual(hits.sort(), [...allowed].sort());
  const home = pageMetadata({
    title: "vet402: verify x402 payments for AI agents",
    description: quotedDescription("src/app/page.tsx"),
    path: "/",
  });
  assert.deepEqual(home.title, { absolute: "vet402: verify x402 payments for AI agents" });
});

test("凍結面のファイルは origin/main と同じで、ethonline の og alt も同じ", () => {
  const diff = execFileSync(
    "git",
    ["diff", "origin/main", "--", "src/app/layout.tsx", "src/app/rwa", "src/app/tokyo", "src/app/ethonline", "AI_USAGE.md", "contracts"],
    { encoding: "utf8" },
  );
  assert.equal(diff, "");
  const layout = read("src/app/layout.tsx");
  const origin = execFileSync("git", ["show", "origin/main:src/app/layout.tsx"], { encoding: "utf8" });
  assert.equal(layout, origin);
  const eth = pageMetadata({ title: "payOrRefuse — ETHOnline 2026", description: "d", path: "/ethonline" });
  const images = (eth.openGraph as { images: Array<{ alt?: string }> }).images;
  assert.equal(images[0].alt, ETHONLINE_OG_IMAGE_ALT);
  const faq = pageMetadata({ title: "T", description: "D", path: "/faq" });
  const faqAlt = (faq.openGraph as { images: Array<{ alt?: string }> }).images[0].alt;
  assert.equal(faqAlt, OG_IMAGE_ALT);
  assert.equal(/\b(we|our|us)\b/i.test(faqAlt ?? ""), false);
  assert.equal(/[;—–]/.test(faqAlt ?? ""), false);
  for (const file of ["src/app/rwa/page.tsx", "src/app/tokyo/page.tsx"]) {
    assert.equal(read(file).includes("pageMetadata"), false, file);
  }
});

test("FAQ の導入は短い x402 の定義を使い、Q1 は承認済みの答えのまま", () => {
  assert.equal(FAQS[0].question, "What is x402?");
  assert.match(FAQS[0].answer, /^x402 is a machine-payment protocol built on the HTTP 402 "Payment Required" status code\./);
  const faq = read("src/app/faq/page.tsx");
  assert.match(faq, /WHAT_IS_X402_LEAD\[0\]/);
  assert.match(faq, /WHAT_IS_X402_LEAD\[1\]/);
  assert.equal(faq.includes("x402 payments for AI agents"), false);
});

test("方法論の TechArticle dateModified は 2026-10-26", () => {
  assert.match(read("src/app/observatory/methodology/page.tsx"), /dateModified: "2026-10-26"/);
});

test("noindex の /sellers は WebPage の JSON-LD を出さない", () => {
  const src = read("src/app/sellers/page.tsx");
  assert.equal(src.includes("webPageJsonLd"), false);
  assert.match(src, /breadcrumbJsonLd/);
  assert.match(src, /noindex:\s*true/);
});

test("/x402 はハブへ 308 で送る", () => {
  assert.match(read("next.config.ts"), /source: "\/x402", destination: "\/x402\/chains", permanent: true/);
});

test("CC BY 4.0 の範囲は l0 export と sellers export と /impact の数字を含む", () => {
  const needles = ["/api/v1/observatory/l0/export.csv", "/api/v1/sellers/export.csv", "/impact"];
  for (const file of ["LICENSE-DATA", "src/app/observatory/methodology/page.tsx", "public/llms.txt"]) {
    const src = read(file);
    for (const needle of needles) assert.ok(src.includes(needle), `${file} ${needle}`);
  }
  const licence = read("public/llms.txt").match(/That licence covers [^.]+/)?.[0] ?? "";
  assert.equal(licence.includes("/api/v1/accuracy"), false);
  assert.equal(licence.includes("census"), false);
  assert.equal(read("public/llms.txt").includes("Three endpoints"), false);
});

test("observatory の説明は L0 の生存確認に agent payments の文を足さない", () => {
  const src = read("src/app/observatory/page.tsx");
  assert.equal(src.includes("The same measurements cover x402 agent payments."), false);
});

test("鍵なしの回数は定数から作り、旗で止まることを書く", () => {
  for (const file of ["src/app/docs/api/page.tsx", "src/app/x402/check-a-seller/page.tsx"]) {
    const src = read(file);
    assert.equal(src.includes("10 / 60"), false, file);
    assert.match(src, /keylessDecisionPerMinute\(\)/);
    assert.match(src, /KEYLESS_READ_STOP/);
  }
  const check = read("src/app/x402/check-a-seller/page.tsx");
  assert.match(check, /On XRPL, verified_terms is null/);
});
