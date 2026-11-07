import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIALS } from "@/lib/about/credentials";
import { liveStatusLabel } from "@/lib/about/live-status-label";
import { parseNpmDownloadsBody } from "@/lib/about/npm-downloads";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("credentials.json loads with four entries and unique ids", () => {
  assert.equal(CREDENTIALS.revision, "2026-11-07");
  assert.equal(CREDENTIALS.credentials.length, 4);
  const ids = CREDENTIALS.credentials.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(CREDENTIALS.credentials.every((c) => c.link === null || c.link.url.startsWith("https://")));
  const near = CREDENTIALS.credentials.find((c) => c.id === "near-japan-background");
  assert.ok(near);
  assert.equal(near!.kind, "background");
  assert.equal(near!.link, null);
});

test("liveStatusLabel: within 48 hours of readAt", () => {
  const readAt = "2026-11-07T12:00:00.000Z";
  const purchase = "2026-11-06T12:00:01.000Z";
  assert.equal(liveStatusLabel(purchase, readAt), "Live, buying daily");
});

test("liveStatusLabel: exactly 48 hours is still buying daily", () => {
  const readAt = "2026-11-09T12:00:00.000Z";
  const purchase = "2026-11-07T12:00:00.000Z";
  assert.equal(liveStatusLabel(purchase, readAt), "Live, buying daily");
});

test("liveStatusLabel: just over 48 hours shows last purchase date", () => {
  const readAt = "2026-11-09T12:00:01.000Z";
  const purchase = "2026-11-07T12:00:00.000Z";
  assert.equal(liveStatusLabel(purchase, readAt), "Live, last purchase 2026-11-07");
});

test("liveStatusLabel: older purchase with readAt", () => {
  assert.equal(
    liveStatusLabel("2026-10-01T08:00:00.000Z", "2026-11-07T12:00:00.000Z"),
    "Live, last purchase 2026-10-01",
  );
});

test("liveStatusLabel: no dates", () => {
  assert.equal(liveStatusLabel(null, null), "Independent Measurement");
});

test("liveStatusLabel: purchase without readAt still shows last purchase", () => {
  assert.equal(liveStatusLabel("2026-10-15T00:00:00.000Z", null), "Live, last purchase 2026-10-15");
});

test("parseNpmDownloadsBody accepts valid payload", () => {
  const out = parseNpmDownloadsBody(
    { package: "@vet402/sdk", downloads: 42, start: "2026-10-01", end: "2026-10-31" },
    "2026-11-07 10:00 UTC",
  );
  assert.deepEqual(out, {
    downloads: 42,
    start: "2026-10-01",
    end: "2026-10-31",
    readAt: "2026-11-07 10:00 UTC",
  });
});

test("parseNpmDownloadsBody rejects malformed payload", () => {
  assert.equal(parseNpmDownloadsBody(null, "2026-11-07 10:00 UTC"), null);
  assert.equal(
    parseNpmDownloadsBody({ package: "@vet402/sdk", downloads: NaN, start: "2026-10-01", end: "2026-10-31" }, "x"),
    null,
  );
  assert.equal(
    parseNpmDownloadsBody({ package: "@vet402/sdk", downloads: 1, start: "bad", end: "2026-10-31" }, "x"),
    null,
  );
});

test("parseNpmDownloadsBody rejects wrong package", () => {
  assert.equal(
    parseNpmDownloadsBody({ package: "@other/sdk", downloads: 1, start: "2026-10-01", end: "2026-10-31" }, "x"),
    null,
  );
});

test("about page source and credentials.json avoid we / our and em dashes", () => {
  const src = read("src/app/about/page.tsx") + "\n" + read("src/lib/about/credentials.json");
  assert.ok(!/\bwe\s/i.test(src), 'about page must not contain "we "');
  assert.ok(!/\bour\s/i.test(src), 'about page must not contain "our "');
  assert.ok(!src.includes("—"), "about page must not contain em dash");
});

test('header About links to /about', () => {
  const header = read("src/components/site/SiteHeader.tsx");
  assert.ok(header.includes('{ label: "About", href: "/about" }'));
});

test("npm の読みは失敗をキャッシュしない（unstable_cache の中に catch を置かない）", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/about/npm-downloads.ts"), "utf8");
  const inner = src.slice(src.indexOf("async function fetchNpmDownloadsUncached"), src.indexOf("const fetchNpmDownloadsCached"));
  assert.ok(inner.length > 0, "fetchNpmDownloadsUncached が見つからない");
  assert.ok(!/catch/.test(inner), "キャッシュの中で失敗を握りつぶすと null が 24 時間残る");
  assert.match(src, /fetchNpmDownloadsCached\(\)\.catch\(\(\) => null\)/);
});

test("liveStatusLabel tolerates a purchase up to 5 minutes newer than the stats read (separate caches)", () => {
  assert.equal(liveStatusLabel("2026-11-07T12:04:00.000Z", "2026-11-07T12:00:00.000Z"), "Live, buying daily");
  assert.equal(liveStatusLabel("2026-11-07T12:06:00.000Z", "2026-11-07T12:00:00.000Z"), "Live, last purchase 2026-11-07");
});
