import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/lib/site-url";
import {
  parseReportMarkdown,
  reportDocumentText,
  sentencesFromReportMarkdown,
} from "@/lib/reports/markdown";

const REPORT_REL = "content/reports/state-of-x402-2026-11.md";
const REPORT_SHA256 = "8bdeb1821277414a191b84d978373fb81c27822cafa7f75d863c7ca09e6186a1";

const PAGE_DESCRIPTION =
  "87.9 percent of vet402's paid call attempts with a final outcome came back with content, as of 2026-11-09 (UTC). Purchases by chain and why calls did not complete.";

test("report markdown sha256 is unchanged", () => {
  const raw = readFileSync(join(process.cwd(), REPORT_REL));
  const hash = createHash("sha256").update(raw).digest("hex");
  assert.equal(hash, REPORT_SHA256);
});

test("every sentence of the report markdown appears in the parsed text tree", () => {
  const markdown = readFileSync(join(process.cwd(), REPORT_REL), "utf8");
  const rendered = reportDocumentText(parseReportMarkdown(markdown));
  for (const sentence of sentencesFromReportMarkdown(markdown)) {
    assert.ok(rendered.includes(sentence), `missing sentence: ${sentence.slice(0, 80)}`);
  }
});

test("metadata description numbers all appear in the report markdown", () => {
  const markdown = readFileSync(join(process.cwd(), REPORT_REL), "utf8");
  const numbers = PAGE_DESCRIPTION.match(/\d[\d.]*%?|\d+/g) ?? [];
  for (const n of numbers) {
    assert.ok(markdown.includes(n.replace(/%$/, "")), `description number not in md: ${n}`);
  }
  assert.ok(markdown.includes("87.9"));
});

test("sitemap includes the dated State of x402 report", () => {
  const url = `${SITE_URL}/x402/report/2026-11`;
  const entry = sitemap().find((e) => e.url === url);
  assert.ok(entry, "missing /x402/report/2026-11");
  assert.equal(String(entry?.lastModified), "2026-11-10");
  assert.equal(entry?.changeFrequency, "yearly");
  assert.equal(entry?.priority, 0.7);
});
