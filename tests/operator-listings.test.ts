// ============================================================
// vet402 が自分で足す出品（operator-listings.ts・2026-11-22）。
//
// 守ること:
//   1. 本番の一覧は規則どおりに読める（https・GET・メインネットの EVM・0x の payTo と asset・正の整数・理由・日付）。
//   2. 規則に合わない行は例外で止まる（黙って捨てない）。POST は載せない（L1 は本文の無い POST に `{}` を送る）。
//   3. 行は source = 'operator' の形で、402 の accept をそのまま raw_accepts に持つ。取得は常に完全。
//   4. 配達フィードの listed_in は 'operator' を返し、?listed_in=operator を受け付ける。
//   5. 公開の文面（llms.txt・openapi.yaml）がこのファイルを名指しし、売り手は払っても頼んでも載らないと言う。
//   6. cron は既存の catalog-sync-aux の中で走る（新しい cron は無い）。
// DB を使う確かめ（行が入る・L1 の候補に同じ上限で入る・フィード）は tests/operator-listings.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPERATOR_LISTINGS,
  OPERATOR_LISTINGS_FILE,
  OPERATOR_SOURCE,
  operatorFetchResult,
  parseOperatorListings,
  type OperatorListing,
} from "@/lib/observatory/operator-listings";
import { feedListedIn, LISTED_IN_CASE_SQL } from "@/lib/delivery/listed-in";
import { parseDeliverySellersQuery } from "@/lib/delivery/sellers-feed-query";
import { CELO_CHAIN } from "@/lib/observatory/x402-payer";

const ROOT = process.cwd();

// gateway.usebuy.ai の生きた 402（2026-11-22・payment-required ヘッダの Celo USDC の accept）を写した形。
// 実物の出品は POST だけなので、ここでは GET の架空の path に付けて規則だけを確かめる。
const fixture = (over: Partial<OperatorListing> = {}): OperatorListing => ({
  url: "https://gateway.example/v1/fixture",
  method: "GET",
  network: "eip155:42220",
  payTo: "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B",
  asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  amount: "5000",
  extra: { name: "USDC", version: "2" },
  maxTimeoutSeconds: 300,
  reason: "Celo seller not in any catalog vet402 reads.",
  addedOn: "2026-11-22",
  ...over,
});

test("本番の一覧は規則どおりに読め、ファイルの名前が実物と一致する", () => {
  const items = parseOperatorListings(OPERATOR_LISTINGS);
  assert.equal(items.length, OPERATOR_LISTINGS.length);
  for (const item of items) assert.equal(item.method, "GET");
  assert.ok(readFileSync(join(ROOT, OPERATOR_LISTINGS_FILE), "utf8").includes("export const OPERATOR_LISTINGS"));
  assert.equal(OPERATOR_SOURCE, "operator");
});

test("行は 402 の accept をそのまま持ち、取得は常に完全", () => {
  const result = operatorFetchResult([fixture()]);
  assert.equal(result.complete, true);
  assert.equal(result.totalCount, 1);
  assert.equal(result.fetchedCount, 1);
  const [item] = result.items;
  assert.equal(item.resourceKey, "gateway.example/v1/fixture");
  assert.equal(item.method, "GET");
  assert.equal(item.network, "eip155:42220");
  assert.equal(item.payTo, "0x20faaca5f980e29639a0fcc6dca6988e18ed333b");
  assert.equal(item.priceAmount, "5000");
  assert.equal(item.priceAsset?.toLowerCase(), CELO_CHAIN.usdc.toLowerCase());
  assert.deepEqual(item.rawAccepts, [
    {
      scheme: "exact",
      network: "eip155:42220",
      amount: "5000",
      asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      payTo: "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    },
  ]);
  // 空の一覧も完全（消した行は次の同期で delisted になる）。
  assert.deepEqual(operatorFetchResult([]), { items: [], totalCount: 0, fetchedCount: 0, complete: true });
});

test("規則に合わない行は例外で止まる", () => {
  const bad: [string, Partial<OperatorListing>][] = [
    ["http", { url: "http://gateway.example/v1/fixture" }],
    ["not a url", { url: "=HYPERLINK(1)" }],
    ["POST", { method: "POST" as "GET" }],
    ["testnet", { network: "eip155:11142220" }],
    ["non-EVM", { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }],
    ["payTo", { payTo: "0x1234" }],
    ["asset", { asset: "USDC" }],
    ["zero amount", { amount: "0" }],
    ["decimal amount", { amount: "0.005" }],
    ["empty reason", { reason: "  " }],
    ["date", { addedOn: "2026-13-45" }],
  ];
  for (const [name, over] of bad) {
    assert.throws(() => parseOperatorListings([fixture(over)]), Error, name);
  }
  assert.throws(() => parseOperatorListings([fixture(), fixture({ url: "https://GATEWAY.example/v1/fixture/" })]), /duplicate/);
});

test("配達フィードの listed_in は operator を返し、?listed_in=operator を受け付ける", () => {
  assert.equal(feedListedIn(OPERATOR_SOURCE), "operator");
  assert.equal(feedListedIn("cdp_bazaar"), "bazaar");
  assert.equal(feedListedIn("something_else"), null);
  assert.match(LISTED_IN_CASE_SQL, /WHEN 'operator' THEN 'operator'/);
  const q = parseDeliverySellersQuery(new URLSearchParams("listed_in=operator"));
  assert.notEqual(q, "invalid");
  assert.equal(q !== "invalid" && q.listedIn, "operator");
});

test("公開の文面がこのファイルを名指しし、売り手は払っても頼んでも載らないと言う", () => {
  const llms = readFileSync(join(ROOT, "public/llms.txt"), "utf8");
  const catalogLine = llms.split("\n").find((l) => l.startsWith("- Catalog sync (what is listed"));
  assert.ok(catalogLine);
  assert.ok(catalogLine.includes(OPERATOR_LISTINGS_FILE));
  assert.ok(catalogLine.includes("listed_in `operator`"));
  assert.ok(catalogLine.includes("sellers cannot pay or ask to be added"));
  const openapi = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");
  assert.ok(openapi.includes(OPERATOR_LISTINGS_FILE));
  assert.ok(openapi.includes("sellers cannot pay or ask to be added"));
  assert.ok(openapi.includes("enum: [bazaar, circle, mpp, operator]"));
});

test("同期は既存の catalog-sync-aux の中で走る（新しい cron は無い）", () => {
  const route = readFileSync(join(ROOT, "src/app/api/cron/catalog-sync-aux/route.ts"), "utf8");
  assert.ok(route.includes("await syncOperatorListings()"));
  const vercel = readFileSync(join(ROOT, "vercel.json"), "utf8");
  assert.ok(!vercel.includes("operator-listings"));
});
