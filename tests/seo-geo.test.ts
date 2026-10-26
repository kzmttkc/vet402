// 2026-10-26 SEO/GEO: 回答頁・sitemap・llms の先導文が同じ文のままであること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sitemap from "@/app/sitemap";
import { LLM_QUESTIONS } from "@/components/site/x402-answers";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";

const REV = "2026-10-26";

test("回答頁とチェーン頁は静的 sitemap に入り、売り手頁は入らない", () => {
  const urls = sitemap();
  for (const q of LLM_QUESTIONS) {
    if (q.path.startsWith("/blog/")) continue;
    const hit = urls.find((e) => e.url.endsWith(q.path));
    assert.ok(hit, q.path);
    assert.equal(String(hit.lastModified).slice(0, 10), REV);
  }
  for (const chain of GUIDE_CHAINS) {
    const hit = urls.find((e) => e.url.endsWith(`/x402/chains/${chain.slug}`));
    assert.ok(hit, chain.slug);
    assert.equal(String(hit.lastModified).slice(0, 10), REV);
  }
  assert.equal(urls.some((e) => e.url.includes("/sellers")), false);
});

test("llms.txt は各回答の先導文と日付を持つ", () => {
  const llms = readFileSync("public/llms.txt", "utf8");
  for (const q of LLM_QUESTIONS) {
    for (const sentence of q.lead) {
      assert.ok(llms.includes(sentence), sentence);
    }
    assert.ok(llms.includes(`https://vet402.com${q.path}`), q.path);
  }
  assert.ok(llms.includes("Content current as of 2026-10-26"));
});

function publicProse(src: string): string {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  const literals = [...noComments.matchAll(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"/g)].map((m) => m[0]);
  // 比較の `>` をタグの終わりと読まない。開きタグの直後のテキストだけを取る。
  const jsx = [...noComments.matchAll(/<(?:[A-Za-z][\w.]*)(?:\s[^<>]*?)?>([^<>{}]*)</g)].map((m) => m[1]);
  return [...literals, ...jsx].join("\n").replaceAll("en-US", "");
}

test("新しい回答の公開文に we、セミコロン、ダッシュが無い", () => {
  const files = [
    "src/components/site/x402-answers.ts",
    "src/components/site/x402-guides.ts",
    "src/app/x402/stablecoin-payments/page.tsx",
    "src/app/x402/check-a-seller/page.tsx",
    "src/app/x402/chains/page.tsx",
    "src/app/x402/chains/[slug]/page.tsx",
    "src/components/site/home/HomeIntro.tsx",
    "src/app/faq/page.tsx",
  ];
  for (const file of files) {
    const prose = publicProse(readFileSync(file, "utf8"));
    assert.equal(/\b(we|our|us)\b/i.test(prose), false, file);
    assert.equal(/[;—–]/.test(prose), false, file);
    assert.equal(/,\s+not\b/.test(prose), false, file);
  }
});
