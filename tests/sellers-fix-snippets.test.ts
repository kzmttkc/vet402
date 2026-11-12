// 売り手が貼る修正コード（課題 C1）。4 スタックそれぞれ、掲載の値が埋まること、
// 無い値が <...> のまま残ること、秘密と環境変数の値を埋めないこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sellerFixListingFrom, sellerFixSnippets, type SellerFixListing } from "@/lib/sellers/fix-snippets";
import { FixFirstView, SellerDetailView } from "@/components/site/sellers/SellersViews";
import { buildSellerBoard, buildSellerDetail, type LatestRow } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const PAY = "0x" + "c1".repeat(20);
const AMOUNT = "8675309";
const NETWORK = "eip155:8453";
const PATH = "/v1/fix-snippet-c1";

const FILLED: SellerFixListing = {
  payTo: PAY,
  amountAtomic: AMOUNT,
  network: NETWORK,
  path: PATH,
  method: "GET",
};

const STACKS = ["express", "next", "hono", "fastapi"] as const;

function codeOf(listing: SellerFixListing, id: (typeof STACKS)[number]): string {
  const hit = sellerFixSnippets(listing).find((s) => s.id === id);
  assert.ok(hit, id);
  return hit.code;
}

function assertPlain(code: string, where: string) {
  assert.doesNotMatch(code, /\b(we|our|us)\b/i, `${where}: we/our/us`);
  assert.doesNotMatch(code, /;/, `${where}: semicolon`);
  assert.doesNotMatch(code, /—|–|--/, `${where}: dash`);
}

for (const id of STACKS) {
  test(`${id}: listing payTo, atomic amount, CAIP-2 network, and path are filled`, () => {
    const code = codeOf(FILLED, id);
    assert.ok(code.includes(PAY), "payTo");
    assert.ok(code.includes(AMOUNT), "amount");
    assert.ok(code.includes(NETWORK), "network");
    assert.ok(code.includes(PATH), "path");
    assertPlain(code, id);
  });
}

for (const id of STACKS) {
  test(`${id}: missing listing values stay <...>`, () => {
    const code = codeOf({}, id);
    assert.equal(code.includes(PAY), false);
    assert.equal(code.includes(AMOUNT), false);
    assert.equal(code.includes(NETWORK), false);
    assert.equal(code.includes(PATH), false);
    assert.match(code, /payTo[\s\S]{0,80}<\.\.\.>/);
    assert.match(code, /amount[\s\S]{0,40}<\.\.\.>/);
    assert.match(code, /network[\s\S]{0,40}<\.\.\.>/);
    assert.match(code, /"<...>":/);
    assertPlain(code, id);
  });
}

const ENV_KEYS = ["SELLER_FIX_PAYTO", "SELLER_FIX_AMOUNT", "SELLER_FIX_NETWORK", "SELLER_FIX_PATH", "SELLER_FIX_SECRET"] as const;

for (const id of STACKS) {
  test(`${id}: secret and environment values are not filled`, () => {
    const envPay = "0x" + "ab".repeat(20);
    const envAmount = "424242";
    const envNetwork = "eip155:999999";
    const envPath = "/env-secret-path";
    const secret = "sk_live_c1_not_in_snippet";
    const privateKey = "0x" + "cd".repeat(32);
    const databaseUrl = "postgres://seller:secret-db-pass@db.internal:5432/vet";
    const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.SELLER_FIX_PAYTO = envPay;
    process.env.SELLER_FIX_AMOUNT = envAmount;
    process.env.SELLER_FIX_NETWORK = envNetwork;
    process.env.SELLER_FIX_PATH = envPath;
    process.env.SELLER_FIX_SECRET = secret;
    try {
      const fromEnv = codeOf(
        { payTo: envPay, amountAtomic: envAmount, network: envNetwork, path: envPath, method: "GET" },
        id,
      );
      assert.equal(fromEnv.includes(envPay), false, "env payTo");
      assert.equal(fromEnv.includes(envAmount), false, "env amount");
      assert.equal(fromEnv.includes(envNetwork), false, "env network");
      assert.equal(fromEnv.includes(envPath), false, "env path");
      assert.equal(fromEnv.includes(secret), false, "env secret");
      assert.match(fromEnv, /<\.\.\.>/);

      const leaked = codeOf(
        { payTo: privateKey, amountAtomic: AMOUNT, network: NETWORK, path: databaseUrl, method: "GET" },
        id,
      );
      assert.equal(leaked.includes(privateKey), false, "private key");
      assert.equal(leaked.includes("secret-db-pass"), false, "database password");
      assert.equal(leaked.includes("postgres"), false, "database url");
      assert.equal(leaked.includes(secret), false, "secret beside a real listing");
      assert.ok(leaked.includes(AMOUNT));
      assert.ok(leaked.includes(NETWORK));

      const clean = codeOf(FILLED, id);
      assert.equal(clean.includes(secret), false);
      assert.equal(clean.includes(envPay), false);
      assert.ok(clean.includes(PAY));
    } finally {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
}

test("a resource URL query or userinfo secret is not pasted, and the path is", () => {
  const secret = "sk_live_querysecret";
  const input = sellerFixListingFrom({
    resourceUrl: `https://user:${secret}@finance.example/v1/quote?api_key=${secret}`,
    priceAmount: AMOUNT,
    method: "GET",
    declaredPayTo: PAY,
    network: NETWORK,
  });
  const joined = sellerFixSnippets(input).map((s) => s.code).join("\n");
  assert.equal(joined.includes(secret), false);
  assert.ok(joined.includes("/v1/quote"));
  assert.ok(joined.includes(PAY));
  assert.ok(joined.includes(AMOUNT));
  assert.ok(joined.includes(NETWORK));
});

test("stellar listings use ExactStellarScheme, not an invented name", () => {
  const stellarPay = "G" + "A".repeat(55);
  const code = codeOf(
    { payTo: stellarPay, amountAtomic: AMOUNT, network: "stellar:pubnet", path: PATH, method: "GET" },
    "express",
  );
  assert.ok(code.includes("ExactStellarScheme"));
  assert.ok(code.includes("@x402/stellar/exact/server"));
  assert.equal(code.includes("ExactEvmScheme"), false);
  assert.ok(code.includes(stellarPay));
  assert.ok(code.includes("stellar:pubnet"));
});

test("express, hono, next, and fastapi snippets name the exported middleware", () => {
  const all = sellerFixSnippets(FILLED);
  const byId = Object.fromEntries(all.map((s) => [s.id, s.code]));
  assert.match(byId.express, /import \{ paymentMiddleware, x402ResourceServer \} from "@x402\/express"/);
  assert.match(byId.express, /HTTPFacilitatorClient/);
  assert.match(byId.express, /ExactEvmScheme/);
  assert.match(byId.hono, /import \{ paymentMiddleware, x402ResourceServer \} from "@x402\/hono"/);
  assert.match(byId.next, /import \{ withX402, x402ResourceServer \} from "@x402\/next"/);
  assert.match(byId.next, /withX402\(/);
  assert.match(byId.fastapi, /from x402\.http\.middleware\.fastapi import payment_middleware/);
  assert.match(byId.fastapi, /ExactEvmServerScheme/);
  assert.match(byId.fastapi, /x402ResourceServer/);
  assert.equal(all.length, 4);
});

function row(p: Partial<SellerRowFacts>): SellerRowFacts {
  return {
    endpointId: "e1",
    status: "settle_failed",
    httpStatusPaid: 500,
    txHash: `0x${"cd".repeat(32)}`,
    attemptedAt: "2026-09-20T12:00:00Z",
    network: NETWORK,
    method: "GET",
    meta: { requestBody: "none", requestQuery: "empty" },
    schema: null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    amountUnits: AMOUNT,
    payTo: PAY,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    declaresHeaders: false,
    pathTemplate: false,
    listingMaxTimeoutSeconds: 20,
    declaredPayTo: PAY,
    declaredAmount: AMOUNT,
    ...p,
  };
}

test("fix-first and the seller page both render the same snippets", () => {
  const latest: LatestRow[] = [{ ...row({ endpointId: "a" }), host: "one.example" }];
  const board = buildSellerBoard([{ host: "one.example", listings: 1 }], latest, "2026-09-28T13:04:05.000Z", null, new Map([["a", new Set(["2026-09-19"])]]));
  const fixHtml = renderToStaticMarkup(createElement(FixFirstView, { board }));
  assert.match(fixHtml, /paymentMiddleware/);
  assert.match(fixHtml, /withX402/);
  assert.match(fixHtml, /payment_middleware/);
  assert.match(fixHtml, /@x402\/hono/);
  assert.match(fixHtml, /&lt;\.\.\.&gt;/);

  const detail = buildSellerDetail(
    "finance.example",
    [
      {
        endpointId: "a",
        resourceKey: "finance.example/v1/quote",
        resourceUrl: "https://finance.example/v1/quote",
        method: "GET",
        priceAmount: AMOUNT,
      },
    ],
    [row({ endpointId: "a" })],
    "2026-09-28T13:04:05.000Z",
  );
  const hostHtml = renderToStaticMarkup(
    createElement(SellerDetailView, { detail, page: 1, now: Date.parse(detail.fetchedAt), revalidateSec: 300 }),
  );
  assert.match(hostHtml, /paymentMiddleware/);
  assert.match(hostHtml, /withX402/);
  assert.match(hostHtml, /payment_middleware/);
  assert.ok(hostHtml.includes(PAY));
  assert.ok(hostHtml.includes(AMOUNT));
  assert.ok(hostHtml.includes(NETWORK));
  assert.ok(hostHtml.includes("/v1/quote"));
});
