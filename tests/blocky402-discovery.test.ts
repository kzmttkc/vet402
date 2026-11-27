// ============================================================
// Blocky402 discovery（Hedera）——目録の 1 件が x402_endpoints の行の形になるか。
// 形は 2026-11-27 に https://api.blocky402.com/discovery/resources で実測した 1 件（Agent Weather の id-mint）。
// ネットワークには出ない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalogItem } from "@/lib/observatory/catalog-source";
import { fetchBlocky402Discovery, BLOCKY402_DISCOVERY_SOURCE, BLOCKY402_DISCOVERY_URL } from "@/lib/observatory/blocky402-discovery";
import { LISTING_SOURCES, LISTING_SYNC_CRON_PATHS, SNAPSHOT_ONLY_SOURCES, BLOCKY402_TESTNET_DISCOVERY_URL } from "@/lib/observatory/listing-sources";

const ITEM = {
  resource: "https://api.agentweather.io/v1/util/id-mint",
  type: "http",
  x402Version: 2,
  accepts: [
    {
      asset: "0.0.0",
      extra: { feePayer: "0.0.10571514", invoiceId: "aw-1", assetSymbol: "HBAR", facilitator: "blocky402" },
      payTo: "0.0.10963430",
      amount: "5802334",
      scheme: "exact",
      network: "hedera:mainnet",
      maxTimeoutSeconds: 120,
    },
  ],
  lastUpdated: "2026-11-21T01:53:14.705Z",
  description: "Pay per call: Give me N fresh time-sortable identifiers.",
  extensions: { bazaar: { info: { input: { type: "http", method: "GET", queryParams: { kind: "uuid7", count: "2" } } } } },
};

test("Blocky402 の 1 件: network・payTo（0.0.x はそのまま）・額・資産・メソッド", () => {
  const p = parseCatalogItem(ITEM);
  assert.equal(p.resourceUrl, "https://api.agentweather.io/v1/util/id-mint");
  assert.equal(p.network, "hedera:mainnet");
  assert.equal(p.payTo, "0.0.10963430");
  assert.equal(p.priceAmount, "5802334");
  assert.equal(p.priceAsset, "0.0.0");
  assert.equal(p.method, "GET");
});

test("fetchBlocky402Discovery: 本番の URL を offset で読む", async () => {
  const seen: string[] = [];
  const r = await fetchBlocky402Discovery({
    fetchImpl: async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ x402Version: 2, items: [ITEM], pagination: { limit: 100, offset: 0, total: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(r.complete, true);
  assert.equal(r.totalCount, 1);
  assert.equal(r.items[0]?.network, "hedera:mainnet");
  assert.ok(seen[0]?.startsWith(BLOCKY402_DISCOVERY_URL));
});

test("出どころの正典: 本番は掲載の出どころ（aux の cron）、試験網は件数の写しだけ", () => {
  const src = LISTING_SOURCES.find((s) => s.source === BLOCKY402_DISCOVERY_SOURCE);
  assert.ok(src);
  assert.equal(src.url, "https://api.blocky402.com/discovery/resources");
  assert.deepEqual(src.sync_times_utc, ["01:30"]);
  assert.equal(LISTING_SYNC_CRON_PATHS[BLOCKY402_DISCOVERY_SOURCE], "/api/cron/catalog-sync-aux");
  assert.ok(SNAPSHOT_ONLY_SOURCES.some((s) => s.url === BLOCKY402_TESTNET_DISCOVERY_URL));
  assert.equal(BLOCKY402_TESTNET_DISCOVERY_URL, "https://api.testnet.blocky402.com/discovery/resources");
});
