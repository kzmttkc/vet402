// /integrity（F9・2026-11-27）の文が正典と食い違わないことを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOES_NOT_TEXT, L1_USER_AGENT } from "../src/app/integrity/page";
import { BUCKET_DOCS } from "../src/lib/sellers/fix-modes";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the User-Agent on /integrity is the one l1-runner sends", () => {
  assert.ok(read("src/lib/observatory/l1-runner.ts").includes(`"user-agent": "${L1_USER_AGENT}"`));
});

test("what vet402 does not do matches llms.txt word for word", () => {
  assert.ok(read("public/llms.txt").includes(DOES_NOT_TEXT));
});

test("the attribution table reads the six canonical outcomes", () => {
  const page = read("src/app/integrity/page.tsx");
  for (const b of Object.keys(BUCKET_DOCS)) assert.ok(page.includes(`bucket: "${b}"`), b);
  assert.equal(Object.keys(BUCKET_DOCS).length, 6);
});

test("/integrity is in the sitemap, footer, methodology and llms.txt page list", () => {
  assert.ok(read("src/app/sitemap.ts").includes("${SITE_URL}/integrity"));
  assert.ok(read("src/components/site/SiteFooter.tsx").includes('href: "/integrity"'));
  assert.ok(read("src/app/observatory/methodology/page.tsx").includes('href="/integrity"'));
  assert.ok(read("public/llms.txt").includes("](https://vet402.com/integrity)"));
});
