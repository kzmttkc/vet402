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
  assert.match(res.headers.get("content-type") ?? "", /^application\/linkset\+json; profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"$/);
  // RFC 9727 section 4.1: the catalog anchor lists every described API as an "item".
  const self = body.linkset.find((e: { anchor: string }) => e.anchor.endsWith("/.well-known/api-catalog"));
  const items = new Set((self?.item ?? []).map((l: { href: string }) => l.href));
  for (const e of body.linkset) if (e !== self) assert.ok(items.has(e.anchor), `item missing for ${e.anchor}`);
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
// 2026-11-27 review: the .md copies share strings with the pages, but some pages still write
// their prose inline. These checks read the page source so a page edit that leaves the .md
// behind turns red, instead of comparing the .md with its own constants.
function pageText(src: string): string {
  return src
    .replace(/\{"\{resourceId\}"\}/g, "{resourceId}")
    .replace(/\{" "\}/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
}

test("methodology page h2 titles and 60-second summary match the shared copy the .md uses", async () => {
  const src = read("src/app/observatory/methodology/page.tsx");
  const h2 = [...src.matchAll(/<h2 className="sec-head"[^>]*>\s*<span className="sec-no">[^<]*<\/span>\s*<span>([^<]+)<\/span>/g)].map(
    (m) => m[1]!.trim(),
  );
  assert.deepEqual(h2, [...METHODOLOGY_H2]);
  const { METHODOLOGY_IN_60 } = await import("@/lib/observatory/methodology-copy");
  assert.ok(pageText(src).includes(METHODOLOGY_IN_60.replace(/\.$/, "")), "In 60 seconds drifted from METHODOLOGY_IN_60");
  const md = await (await getMethodologyMd()).text();
  assert.match(md, /This Markdown is a summary/, "methodology.md must say it is a summary");
});

test("check-a-seller .md bodies say what the page says", async () => {
  const { KEYLESS_READ_STOP, keylessDecisionPerMinute } = await import("@/lib/api/keyless-limits");
  const page = pageText(read("src/app/x402/check-a-seller/page.tsx"));
  for (const [key, section] of Object.entries(CHECK_SELLER_SECTIONS)) {
    const body = section.body
      .replace(KEYLESS_READ_STOP, "{KEYLESS_READ_STOP}")
      .replace(`at ${keylessDecisionPerMinute()} requests`, "at {keylessDecisionPerMinute()} requests");
    for (const sentence of body.split(/(?<=\.)\s+/)) {
      // Interpolated values and link text differ in form between JSX and Markdown; the rest must match.
      if (/https?:\/\/|Shapes are in|^Start from|as the FAQ states|^Do not proceed/.test(sentence)) continue;
      if (sentence.length < 20) continue;
      assert.ok(page.includes(sentence), `${key}: page lacks "${sentence}"`);
    }
  }
});

// Sentences the .md copies by hand from integrity and erc-8004. Each must be on the page and in the .md,
// so neither side can drop a limit (what ALLOW promises, what a match is) without a red test.
test("integrity.md and erc-8004.md keep the page's limiting sentences", async () => {
  const cases: { page: string; md: string; sentences: string[] }[] = [
    {
      page: "src/app/integrity/page.tsx",
      md: await (await getIntegrityMd()).text(),
      sentences: [
        "An outcome that counts neither way can still keep a check from ALLOW.",
        "ALLOW, WARN and BLOCK are recommendations to the customer who asked.",
        "vet402 does not accept, refuse, delay or reverse anyone's payment.",
        "An ALLOW is the fact that the terms vet402 paid were delivered, not a promise about a different recipient or a higher price.",
        "A buyer relies on vet402 to say what a seller delivered.",
      ],
    },
    {
      page: "src/app/erc-8004/page.tsx",
      md: await (await getErc8004Md()).text(),
      sentences: [
        "A registration shows that an agent exists.",
        "Names and endpoint URLs are not used.",
        "It needs no key. The same check is the MCP tool check_8004_agent.",
        "The standard expects each registry to be deployed as a singleton per chain.",
      ],
    },
  ];
  for (const c of cases) {
    const page = pageText(read(c.page));
    for (const s of c.sentences) {
      assert.ok(page.includes(s), `${c.page} lacks "${s}"`);
      assert.ok(c.md.includes(s), `${c.page}.md lacks "${s}"`);
    }
  }
});
