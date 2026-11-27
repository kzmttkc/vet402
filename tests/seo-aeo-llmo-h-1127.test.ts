// 2026-11-27 依頼 H: llms index, page .md mirrors, /.well-known/api-catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET as getApiCatalog } from "@/app/.well-known/api-catalog/route";
import { GET as getCheckSellerMd } from "@/app/x402/check-a-seller.md/route";
import { GET as getGlossaryMd } from "@/app/x402/glossary.md/route";
import { GET as getStatisticsMd } from "@/app/x402/statistics.md/route";
import { GET as getIntegrityMd } from "@/app/integrity.md/route";
import { GET as getErc8004Md } from "@/app/erc-8004.md/route";
import { GET as getMethodologyMd } from "@/app/observatory/methodology.md/route";
import { METHODOLOGY_H2, METHODOLOGY_TITLE } from "@/lib/observatory/methodology-copy";
import { CHECK_SELLER } from "@/components/site/x402-answers";
import { CHECK_SELLER_SECTIONS } from "@/lib/x402/check-a-seller-sections";
import { FRESHNESS_LEAD, freshnessLines } from "@/lib/observatory/freshness";

const ROOT = join(process.cwd());
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function headingsFromMd(text: string): { h1: string[]; h2: string[] } {
  const h1: string[] = [];
  const h2: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) h1.push(line.slice(2).trim());
    if (line.startsWith("## ")) h2.push(line.replace(/^##\s+(\d+\.\s+)?/, "").trim());
  }
  return { h1, h2 };
}

function headingsFromPage(src: string): { h1: string[]; h2: string[] } {
  const h1 = [...src.matchAll(/<h1[^>]*>([^<]+)</g)].map((m) => m[1]!.replace(/&apos;/g, "'").trim());
  const h2 = [...src.matchAll(/<h2[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m[1]!.trim());
  const h2plain = [...src.matchAll(/<h2[^>]*className="sec-head mt-8">([^<]+)</g)].map((m) => m[1]!.trim());
  return { h1, h2: [...h2, ...h2plain] };
}

test("llms.txt stays an index and points at llms-full and page .md routes", () => {
  const llms = read("public/llms.txt");
  assert.ok(llms.includes("## Key figures"));
  assert.ok(llms.includes("https://vet402.com/llms-full.txt"));
  assert.ok(!llms.includes("<!-- rules-text:begin -->"), "rules text belongs in llms-full-prose");
  assert.ok(read("public/llms-full-prose.txt").includes("<!-- rules-text:begin -->"));
  assert.ok(llms.includes("/x402/glossary.md"));
  assert.ok(llms.includes("/.well-known/api-catalog"));
  const size = Buffer.byteLength(llms, "utf8");
  assert.ok(size < 40_000, `llms.txt still ${size} B`);
});

test("llms index Freshness matches freshness.ts", () => {
  const llms = read("public/llms.txt");
  assert.ok(llms.includes(FRESHNESS_LEAD));
  for (const line of freshnessLines()) assert.ok(llms.includes(line), line);
});

test("api-catalog returns valid RFC 9727 linkset JSON", async () => {
  const res = await getApiCatalog();
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.ok(Array.isArray(body.linkset));
  const api = body.linkset.find((e: { anchor: string }) => e.anchor.endsWith("/api/v1"));
  assert.ok(api?.["service-desc"]?.some((l: { href: string }) => l.href.endsWith("/openapi.json")));
  assert.ok(body.linkset.some((e: { anchor: string }) => e.anchor.endsWith("/api/v1/check")));
  assert.ok(body.linkset.some((e: { anchor: string }) => e.anchor.endsWith("/api/v1/observatory/state")));
  assert.match(res.headers.get("content-type") ?? "", /linkset\+json/);
});

const MD_ROUTES: { path: string; get: () => Response | Promise<Response> }[] = [
  { path: "x402/check-a-seller", get: getCheckSellerMd },
  { path: "x402/glossary", get: getGlossaryMd },
  { path: "x402/statistics", get: getStatisticsMd },
  { path: "integrity", get: getIntegrityMd },
  { path: "erc-8004", get: getErc8004Md },
  { path: "observatory/methodology", get: getMethodologyMd },
];

for (const { path, get } of MD_ROUTES) {
  test(`${path}.md returns non-empty markdown`, async () => {
    const res = await get();
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.length > 80, path);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    assert.ok(text.includes("# "));
  });
}

test("metadata lists text/markdown alternates on pillar pages", () => {
  for (const file of [
    "src/app/x402/check-a-seller/page.tsx",
    "src/app/x402/glossary/page.tsx",
    "src/app/x402/statistics/page.tsx",
    "src/app/integrity/page.tsx",
    "src/app/erc-8004/page.tsx",
    "src/app/observatory/methodology/page.tsx",
  ]) {
    assert.match(read(file), /markdown:\s*true/, file);
  }
});

test("check-a-seller .md h2 titles match the page", async () => {
  const md = headingsFromMd(await (await getCheckSellerMd()).text());
  const expected = [
    CHECK_SELLER_SECTIONS.checkByUrl.title,
    CHECK_SELLER_SECTIONS.readDecision.title,
    CHECK_SELLER_SECTIONS.purchaseRecord.title,
    CHECK_SELLER_SECTIONS.compareTerms.title,
  ];
  assert.equal(md.h1[0], CHECK_SELLER.h1);
  assert.deepEqual(md.h2, expected);
});

test("methodology .md lists the same main h2 titles as the page outline", async () => {
  const md = headingsFromMd(await (await getMethodologyMd()).text());
  assert.equal(md.h1[0], METHODOLOGY_TITLE);
  assert.deepEqual(
    md.h2,
    METHODOLOGY_H2.map((t) => t),
  );
});