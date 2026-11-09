import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  INDEXNOW_KEY,
  parseSitemap,
  selectUrls,
  buildPayload,
} from "../scripts/indexnow-lib.mjs";

const SAMPLE_WITH_LASTMOD = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://vet402.com/</loc>
    <lastmod>2026-11-08</lastmod>
  </url>
  <url>
    <loc>https://vet402.com/memo</loc>
    <lastmod>2026-11-08</lastmod>
  </url>
  <url>
    <loc>https://vet402.com/connect</loc>
    <lastmod>2026-11-07</lastmod>
  </url>
</urlset>`;

const SAMPLE_NO_LASTMOD = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://vet402.com/about</loc></url>
</urlset>`;

test("parseSitemap reads loc and lastmod from url blocks", () => {
  const rows = parseSitemap(SAMPLE_WITH_LASTMOD);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { loc: "https://vet402.com/", lastmod: "2026-11-08" });
  assert.deepEqual(rows[2], { loc: "https://vet402.com/connect", lastmod: "2026-11-07" });
});

test("parseSitemap sets lastmod null when absent", () => {
  const rows = parseSitemap(SAMPLE_NO_LASTMOD);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { loc: "https://vet402.com/about", lastmod: null });
});

test("selectUrls with all=false keeps recent URLs plus home and drops old and off-host", () => {
  const entries = [
    ...parseSitemap(SAMPLE_WITH_LASTMOD),
    { loc: "https://evil.example/old", lastmod: "2026-11-08" },
    { loc: "http://vet402.com/http-only", lastmod: "2026-11-08" },
    { loc: "https://vet402.com/ancient", lastmod: "2020-01-01" },
  ];
  const now = new Date("2026-11-09T12:00:00Z");
  const urls = selectUrls(entries, { all: false, sinceDays: 3, now, host: "vet402.com" });
  assert.ok(urls.includes("https://vet402.com/"));
  assert.ok(urls.includes("https://vet402.com/memo"));
  assert.ok(urls.includes("https://vet402.com/connect"));
  assert.ok(!urls.includes("https://evil.example/old"));
  assert.ok(!urls.includes("http://vet402.com/http-only"));
  assert.ok(!urls.includes("https://vet402.com/ancient"));
});

test("selectUrls with all=true keeps every on-host https loc", () => {
  const entries = [
    ...parseSitemap(SAMPLE_WITH_LASTMOD),
    { loc: "https://vet402.com/ancient", lastmod: "2020-01-01" },
    { loc: "https://other.host/page", lastmod: "2026-11-08" },
  ];
  const urls = selectUrls(entries, { all: true, host: "vet402.com" });
  assert.equal(urls.length, 4);
  assert.ok(urls.includes("https://vet402.com/ancient"));
  assert.ok(!urls.some((u) => u.includes("other.host")));
});

test("buildPayload matches IndexNow shape", () => {
  const payload = buildPayload("vet402.com", ["https://vet402.com/"]);
  assert.deepEqual(payload, {
    host: "vet402.com",
    key: INDEXNOW_KEY,
    keyLocation: `https://vet402.com/${INDEXNOW_KEY}.txt`,
    urlList: ["https://vet402.com/"],
  });
});

test("public key file matches INDEXNOW_KEY", () => {
  const keyPath = path.join(process.cwd(), "public", `${INDEXNOW_KEY}.txt`);
  const body = fs.readFileSync(keyPath, "utf8").trim();
  assert.equal(body, INDEXNOW_KEY);
});
