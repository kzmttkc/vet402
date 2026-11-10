import { test } from "node:test";
import assert from "node:assert/strict";
import sitemap from "@/app/sitemap";
import { getAllPosts } from "@/lib/blog";

test("sitemap includes the observatory entry points", () => {
  const urls = sitemap().map((entry) => entry.url);
  assert.ok(urls.includes("https://vet402.com/observatory"), "missing /observatory");
  assert.ok(urls.includes("https://vet402.com/observatory/state"), "missing /observatory/state");
  assert.ok(
    urls.includes("https://vet402.com/observatory/methodology"),
    "missing /observatory/methodology",
  );
});

test("sitemap does not enumerate dynamic per-endpoint observatory pages", () => {
  const urls = sitemap().map((entry) => entry.url);
  assert.ok(
    !urls.some((u) => u.includes("/observatory/e/")),
    "dynamic /observatory/e/{id} pages must not be enumerated (unbounded, like /payee/{address})",
  );
});

test("sitemap includes /memo", () => {
  const urls = sitemap().map((entry) => entry.url);
  assert.ok(urls.includes("https://vet402.com/memo"), "missing /memo");
});

test("sitemap includes the x402 pillar page", () => {
  const entry = sitemap().find((e) => e.url === "https://vet402.com/x402");
  assert.ok(entry, "missing /x402");
  assert.equal(String(entry?.lastModified), "2026-11-10");
  assert.equal(entry?.changeFrequency, "daily");
  assert.equal(entry?.priority, 0.9);
});

test("sitemap includes the dated x402 report snapshot", () => {
  const entry = sitemap().find((e) => e.url === "https://vet402.com/x402/report/2026-11");
  assert.ok(entry, "missing /x402/report/2026-11");
  assert.equal(String(entry?.lastModified), "2026-11-10");
  assert.equal(entry?.changeFrequency, "yearly");
  assert.equal(entry?.priority, 0.7);
});

test("sitemap includes x402 guide entry points", () => {
  const urls = sitemap().map((entry) => entry.url);
  assert.ok(urls.includes("https://vet402.com/x402/check-a-seller"), "missing /x402/check-a-seller");
  assert.ok(urls.includes("https://vet402.com/x402/chains"), "missing /x402/chains");
  assert.ok(urls.includes("https://vet402.com/x402/stablecoin-payments"), "missing /x402/stablecoin-payments");
  const slugs = getAllPosts().map((p) => p.slug);
  if (slugs.includes("what-is-x402")) {
    assert.ok(urls.includes("https://vet402.com/blog/what-is-x402"), "missing /blog/what-is-x402");
  }
});
