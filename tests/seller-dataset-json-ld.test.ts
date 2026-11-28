// Indexed seller pages: ItemPage + Dataset JSON-LD (2026-11-28).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DATA_LICENSE_URL, ORGANIZATION_ID } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { buildSellerDetail } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";
import {
  sellerPurchaseRecordDatasetJsonLd,
  sellerRecordVariableMeasured,
  sellerReputationDatasetJsonLd,
  sellerReputationVariableMeasured,
} from "@/lib/sellers/seller-json-ld";
import { ReputationSellerArticle } from "@/app/x402/sellers/[host]/page";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const delivered: SellerRowFacts = {
  endpointId: "e1",
  status: "settled",
  httpStatusPaid: 200,
  txHash: "0x" + "aa".repeat(32),
  attemptedAt: "2026-11-16T12:00:00Z",
  network: "eip155:8453",
  method: "GET",
  meta: null,
  schema: null,
  unpaidStatus: null,
  selection: null,
  verifyReason: null,
};

function sampleDetail() {
  return buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
      { endpointId: "e3", resourceKey: "shop.example/x", resourceUrl: "https://shop.example/x", method: "GET", priceAmount: "1" },
    ],
    [
      delivered,
      { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" },
      { ...delivered, endpointId: "e2", status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-11-10T11:00:00Z" },
    ],
    "2026-11-16T13:00:00.000Z",
  );
}

function propertyValues(doc: ReturnType<typeof sellerPurchaseRecordDatasetJsonLd>) {
  return doc.variableMeasured.filter(
    (v): v is { "@type": "PropertyValue"; name: string; value: string | number } =>
      typeof v === "object" && v !== null && v["@type"] === "PropertyValue",
  );
}

function parseJsonLdScripts(html: string): unknown[] {
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const out: unknown[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(JSON.parse(m[1]!));
  }
  return out;
}

test("seller purchase record Dataset has required fields and public distribution URLs", () => {
  const detail = sampleDetail();
  const doc = sellerPurchaseRecordDatasetJsonLd(detail);
  assert.equal(doc["@type"], "Dataset");
  assert.equal(doc.name, "shop.example: x402 purchase results on Base, latest attempt 2026-11-16");
  assert.ok(doc.description.includes("shop.example"));
  assert.equal(doc.url, `${SITE_URL}/sellers/shop.example`);
  assert.equal(doc.license, DATA_LICENSE_URL);
  assert.equal(doc.dateModified, "2026-11-16T12:00:00Z", "newest attempt shown on the page, not the read time");
  assert.equal(doc.creator["@id"], ORGANIZATION_ID);
  assert.equal(doc.publisher["@id"], ORGANIZATION_ID);
  assert.ok(doc.distribution.length >= 2);
  for (const row of doc.distribution) {
    assert.ok(row.contentUrl.startsWith(SITE_URL));
  }
  assert.ok(doc.distribution.some((d) => d.contentUrl.endsWith("/api/v1/sellers/export.csv")));
  assert.ok(doc.distribution.some((d) => d.contentUrl.includes("/api/v1/observatory/export.csv?days=")));
  assert.ok(!JSON.stringify(doc).includes("revenue"), "no revenue fields (C2)");
  assert.ok(!JSON.stringify(doc).includes("price_usd"), "no price fields (C2)");
});

test("seller record variableMeasured matches SellerDetail counts shown on the page", () => {
  const detail = sampleDetail();
  const measured = sellerRecordVariableMeasured(detail);
  const doc = sellerPurchaseRecordDatasetJsonLd(detail);
  const props = propertyValues(doc);
  assert.equal(props.length, measured.filter((m) => typeof m !== "string").length);
  assert.equal(props.find((p) => p.name === "Base listings")?.value, detail.summary.listings);
  assert.equal(props.find((p) => p.name === "Latest result delivered (per listing)")?.value, detail.sellerView.delivered);
  assert.equal(props.find((p) => p.name === "Ledger read time")?.value, detail.fetchedAt);
});

test("reputation Dataset variableMeasured matches detail evidence", () => {
  const detail = sampleDetail();
  const doc = sellerReputationDatasetJsonLd(detail);
  assert.equal(doc["@type"], "Dataset");
  const props = doc.variableMeasured.filter(
    (v): v is { "@type": "PropertyValue"; name: string; value: string | number } =>
      typeof v === "object" && v["@type"] === "PropertyValue",
  );
  const expected = sellerReputationVariableMeasured(detail);
  for (const row of expected) {
    if (typeof row === "string") continue;
    assert.deepEqual(
      props.find((p) => p.name === row.name)?.value,
      row.value,
      row.name,
    );
  }
});

test("indexed reputation page emits ItemPage and Dataset; noindex emits neither", () => {
  const detail = sampleDetail();
  const indexed = renderToStaticMarkup(
    createElement(ReputationSellerArticle, { detail, indexable: true }),
  );
  const hidden = renderToStaticMarkup(
    createElement(ReputationSellerArticle, { detail, indexable: false }),
  );
  const indexedDocs = parseJsonLdScripts(indexed);
  const hiddenDocs = parseJsonLdScripts(hidden);
  assert.equal(indexedDocs.some((d) => (d as { "@type"?: string })["@type"] === "ItemPage"), true);
  assert.equal(indexedDocs.some((d) => (d as { "@type"?: string })["@type"] === "Dataset"), true);
  assert.equal(hiddenDocs.length, 0);
});

test("page wiring: builders only when indexable", () => {
  const sellersPage = read("src/app/sellers/[host]/page.tsx");
  assert.match(sellersPage, /sellerPurchaseRecordDatasetJsonLd/);
  assert.match(sellersPage, /sellerItemPageJsonLd/);
  assert.match(sellersPage, /indexable\s*\?/);
  assert.doesNotMatch(sellersPage, /"@type":\s*"WebPage"/);
  const repPage = read("src/app/x402/sellers/[host]/page.tsx");
  assert.match(repPage, /sellerReputationDatasetJsonLd/);
  assert.match(repPage, /indexable/);
  assert.doesNotMatch(repPage, /"@type":\s*"ItemPage"/);
});

test("noindex seller index list page does not emit seller Dataset JSON-LD", () => {
  const sellersIndex = read("src/app/sellers/page.tsx");
  assert.match(sellersIndex, /noindex:\s*true/);
  assert.doesNotMatch(sellersIndex, /sellerPurchaseRecordDatasetJsonLd/);
  assert.doesNotMatch(sellersIndex, /datasetJsonLd/);
});

test("Dataset JSON-LD on indexed seller pages parses and listing count matches rendered summary", () => {
  const detail = sampleDetail();
  const doc = sellerPurchaseRecordDatasetJsonLd(detail);
  const serialized = JSON.stringify(doc);
  assert.doesNotThrow(() => JSON.parse(serialized));
  const listings = doc.variableMeasured.find(
    (v) => typeof v === "object" && v.name === "Base listings",
  ) as { value: number };
  assert.equal(listings.value, detail.summary.listings);
});
test("ledger CSV link covers the newest delivered row on both seller pages (claimed hosts older than 30 days)", () => {
  const listing = { endpointId: "e1", resourceKey: "old.example/api", resourceUrl: "https://old.example/api", method: "GET", priceAmount: "1" };
  const ledgerUrl = (doc: { distribution: { contentUrl: string }[] }) =>
    doc.distribution.find((d) => d.contentUrl.includes("/api/v1/observatory/export.csv"))?.contentUrl;
  const old = buildSellerDetail("old.example", [listing], [{ ...delivered, attemptedAt: "2026-09-20T12:00:00Z" }], "2026-11-16T13:00:00.000Z");
  assert.equal(ledgerUrl(sellerPurchaseRecordDatasetJsonLd(old)), `${SITE_URL}/api/v1/observatory/export.csv?days=59`);
  assert.equal(ledgerUrl(sellerReputationDatasetJsonLd(old)), `${SITE_URL}/api/v1/observatory/export.csv?days=59`);
  const ancient = buildSellerDetail("old.example", [listing], [{ ...delivered, attemptedAt: "2025-01-01T00:00:00Z" }], "2026-11-16T13:00:00.000Z");
  assert.equal(ledgerUrl(sellerReputationDatasetJsonLd(ancient)), `${SITE_URL}/api/v1/observatory/export.csv?days=366`);
  const fresh = sampleDetail();
  assert.equal(ledgerUrl(sellerReputationDatasetJsonLd(fresh)), `${SITE_URL}/api/v1/observatory/export.csv?days=30`);
});
