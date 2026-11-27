// PMF85 r4: hero ledger split, paste record note, narrow UI, skip link, vet402 voice, legal lastmod, runbook §9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import sitemap from "@/app/sitemap";
import {
  LEGAL_PRIVACY_DISPLAY,
  LEGAL_PRIVACY_LAST_MODIFIED,
  LEGAL_TERMS_PRIVACY_LAST_MODIFIED,
  LEGAL_TERMS_PRIVACY_DISPLAY,
} from "@/lib/legal/document-dates";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const VOICE_PATHS = [
  "src/app/memo/page.tsx",
  "src/app/status/page.tsx",
  "src/app/faq/page.tsx",
  "src/app/docs/api/page.tsx",
  "src/lib/docs/api-endpoints-data.tsx",
  "src/components/site/faq-data.ts",
];

function visibleProseFromTsx(src: string): string {
  return src
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{`[\s\S]*?`\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");
}

test("home hero: not delivered and inconclusive settled partition settled minus delivered", async () => {
  const page = read("src/app/page.tsx");
  assert.match(page, /ledger\.settled - ledger\.delivered - inconclusiveSettled/);
  assert.match(page, /Settled, inconclusive \(4xx\)/);
  assert.match(page, /stats\?\.l1\.inconclusiveSettled/);

  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  assert.equal(res.status, 200);
  const body = await res.json();
  const { settled, delivered, inconclusiveSettled } = body.l1;
  const notDelivered = Math.max(0, settled - delivered - inconclusiveSettled);
  assert.equal(notDelivered + inconclusiveSettled + delivered, settled);
});

test("PasteCheck: record update note on record and same-host outcomes", () => {
  const src = read("src/components/site/home/PasteCheck.tsx");
  assert.match(
    src,
    /The record updates after each purchase\. Open it to get an email when it changes\./,
  );
  assert.match(src, /aria-live="polite"/);
  assert.match(src, /placeholder=\{EXAMPLE_X402_URL\}/);
  assert.doesNotMatch(src, /\/v1\/quote"/);
});

test("observatory network filter stacks full width below sm", () => {
  const src = read("src/app/observatory/page.tsx");
  const labelStart = src.lastIndexOf("<label", src.indexOf('name="network"'));
  const block = src.slice(labelStart, src.indexOf('name="network"') + 220);
  assert.match(block, /basis-full/);
  assert.match(block, /w-full max-sm:text/);
});

test("home skip link to paste field is second in tab order", () => {
  const chrome = read("src/components/site/SiteChrome.tsx");
  const mainSkip = chrome.indexOf("Skip to main content");
  const pasteSkip = chrome.indexOf("Skip to the URL check");
  assert.ok(mainSkip >= 0 && pasteSkip > mainSkip);
  assert.match(chrome, /href="#lp-paste-url"/);
  assert.match(read("src/components/site/home/PasteCheck.tsx"), /id="lp-paste-url"/);
  const headerAt = chrome.indexOf("<SiteHeader");
  assert.ok(pasteSkip < headerAt, "skip links precede header chrome");
});

test("vet402 voice: no we/our/us in public prose on memo, status, faq, docs/api, faq-data", () => {
  const banned = /\b(we|our|us)\b/gi;
  for (const rel of VOICE_PATHS) {
    const prose = visibleProseFromTsx(read(rel));
    const hits = [...prose.matchAll(banned)].filter((m) => {
      const before = prose.slice(Math.max(0, m.index! - 60), m.index);
      return !/https?:\/\/[^\s]*$/.test(before) && !/\/en-us\//.test(before);
    });
    assert.deepEqual(
      hits.map((h) => h[0]),
      [],
      `${rel}: found we/our/us in visible prose`,
    );
  }
});

test("sitemap legal lastmod reads from the same constant as the legal pages", async () => {
  const entries = await sitemap();
  const terms = entries.find((e) => e.url.endsWith("/legal/terms"));
  const privacy = entries.find((e) => e.url.endsWith("/legal/privacy"));
  assert.ok(terms);
  assert.ok(privacy);
  assert.equal(String(terms!.lastModified), LEGAL_TERMS_PRIVACY_LAST_MODIFIED);
  assert.equal(String(privacy!.lastModified), LEGAL_PRIVACY_LAST_MODIFIED);
  assert.match(read("src/app/legal/terms/page.tsx"), /Last updated: \{LEGAL_TERMS_PRIVACY_DISPLAY\}/);
  assert.match(read("src/app/legal/privacy/page.tsx"), new RegExp(`Last updated: ${LEGAL_PRIVACY_DISPLAY}`));
});

test("INCIDENT_RUNBOOK §9 documents Neon point-in-time restore", () => {
  const doc = read("docs/INCIDENT_RUNBOOK.md");
  assert.match(doc, /## 9\. データベースを戻す/);
  assert.match(doc, /point-in-time/);
  const section9 = doc.slice(doc.indexOf("## 9."));
  assert.match(section9, /https:\/\/vet402\.com\/api\/health/);
});