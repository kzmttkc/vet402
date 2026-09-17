// ============================================================
// vet402 Observatory L0 — MPP directory（Tempo・2026-09-17）。
//
// fixture は GET https://mpp.dev/api/services の実測の形から切り出した（値は短縮）。
// 守ること: tempo/charge だけを行にする、resourceUrl は serviceUrl + path、
// network は eip155:4217、pay_to は null（directory に無い）、rawAccepts に realm と
// unitType を残す、上限を超えたら complete=false と言う、fetch の失敗は空・incomplete。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MPP_DIRECTORY_MAX_ITEMS,
  MPP_DIRECTORY_SOURCE,
  fetchMppDirectory,
  joinServiceUrl,
  parseMppDirectory,
  parseMppEndpoint,
} from "@/lib/observatory/mpp-directory";

const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";

const FIXTURE = {
  version: "1",
  services: [
    {
      id: "fal",
      name: "fal.ai",
      url: "https://fal.mpp.tempo.xyz",
      serviceUrl: "https://fal.mpp.tempo.xyz/",
      realm: "fal.mpp.tempo.xyz",
      status: "live",
      integration: "first-party",
      categories: ["image"],
      docs: { apiReference: "https://fal.mpp.tempo.xyz/openapi.json", llmsTxt: "https://fal.mpp.tempo.xyz/llms.txt" },
      methods: { tempo: { intents: ["charge"], assets: [USDC_E] } },
      endpoints: [
        {
          method: "POST",
          path: "/fal-ai/flux/dev",
          description: "Generate an image",
          payment: { intent: "charge", method: "tempo", currency: USDC_E, decimals: 6, amount: "25000", unitType: "request" },
        },
        {
          method: "GET",
          path: "/jobs/:id",
          description: "Job status (templated path)",
          payment: { intent: "charge", method: "tempo", currency: USDC_E, decimals: 6, amount: "1000", unitType: "request" },
        },
        {
          method: "POST",
          path: "/session",
          description: "Session intent — not measured",
          payment: { intent: "session", method: "tempo", currency: USDC_E, decimals: 6, amount: "1000", unitType: "request" },
        },
        {
          method: "POST",
          path: "/stripe-only",
          payment: { intent: "charge", method: "stripe", currency: "usd", decimals: 2, amount: "100", unitType: "request" },
        },
        { method: "PATCH", path: "/weird", payment: { intent: "charge", method: "tempo", currency: USDC_E, decimals: 6, amount: "5", unitType: "request" } },
      ],
    },
    {
      id: "no-endpoints",
      name: "Empty",
      serviceUrl: "https://empty.example",
      realm: "empty.example",
      endpoints: [],
    },
  ],
};

test("joinServiceUrl joins with one slash", () => {
  assert.equal(joinServiceUrl("https://a.example/", "/v1/x"), "https://a.example/v1/x");
  assert.equal(joinServiceUrl("https://a.example", "v1/x"), "https://a.example/v1/x");
});

test("parseMppDirectory maps tempo/charge endpoints only, in the catalog row shape", () => {
  const { items, endpointCount, complete } = parseMppDirectory(FIXTURE);
  assert.equal(complete, true);
  // tempo/charge: flux/dev, jobs/:id, /weird（PATCH → method 未宣言だが行にはなる）
  assert.equal(endpointCount, 3);
  assert.equal(items.length, 3);
  const flux = items.find((i) => i.resourceUrl === "https://fal.mpp.tempo.xyz/fal-ai/flux/dev");
  assert.ok(flux, "flux/dev row exists");
  assert.equal(flux.resourceKey, "fal.mpp.tempo.xyz/fal-ai/flux/dev");
  assert.equal(flux.method, "POST");
  assert.equal(flux.network, "eip155:4217");
  assert.equal(flux.payTo, null, "the directory carries no recipient");
  assert.equal(flux.priceAmount, "25000");
  assert.equal(flux.priceAsset, USDC_E);
  assert.equal(flux.description, "Generate an image");
  assert.equal(flux.declaredSchema, null);
  const accepts = flux.rawAccepts as Record<string, unknown>[];
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0].scheme, "mpp:charge");
  assert.equal(accepts[0].network, "eip155:4217");
  assert.equal(accepts[0].asset, USDC_E);
  assert.equal(accepts[0].amount, "25000");
  assert.equal(accepts[0].payTo, null);
  const extra = accepts[0].extra as Record<string, unknown>;
  assert.equal(extra.realm, "fal.mpp.tempo.xyz");
  assert.equal(extra.intent, "charge");
  assert.equal(extra.unitType, "request");
  assert.equal(extra.decimals, 6);
  // テンプレート path はカタログに残る（L0 が path_template、L1 は候補にしない——Bazaar と同じ）
  const jobs = items.find((i) => i.resourceUrl === "https://fal.mpp.tempo.xyz/jobs/:id");
  assert.ok(jobs);
  // 認めない method は未宣言（null）——推測して測らない
  const weird = items.find((i) => i.resourceUrl === "https://fal.mpp.tempo.xyz/weird");
  assert.equal(weird?.method, null);
  // session / stripe は行にならない
  assert.equal(items.some((i) => i.resourceUrl.endsWith("/session")), false);
  assert.equal(items.some((i) => i.resourceUrl.endsWith("/stripe-only")), false);
});

test("parseMppEndpoint refuses rows without serviceUrl / path / payment, and drops endpoints on any chain but Tempo mainnet (4217)", () => {
  assert.equal(parseMppEndpoint({ serviceUrl: "https://a.example" }, { path: "/x" }), null);
  assert.equal(parseMppEndpoint({}, { path: "/x", payment: { intent: "charge", method: "tempo", currency: USDC_E, amount: "1" } }), null);
  const moderato = parseMppEndpoint(
    { serviceUrl: "https://a.example", realm: "a.example" },
    { method: "GET", path: "/x", payment: { intent: "charge", method: "tempo", currency: USDC_E, amount: "1", chainId: 42431 } },
  );
  assert.equal(moderato, null, "Moderato (42431) is not measured (review #4)");
  const other = parseMppEndpoint(
    { serviceUrl: "https://a.example", realm: "a.example" },
    { method: "GET", path: "/x", payment: { intent: "charge", method: "tempo", currency: USDC_E, amount: "1", chainId: 8453 } },
  );
  assert.equal(other, null);
  const mainnet = parseMppEndpoint(
    { serviceUrl: "https://a.example", realm: "a.example" },
    { method: "GET", path: "/x", payment: { intent: "charge", method: "tempo", currency: USDC_E, amount: "1", chainId: 4217 } },
  );
  assert.equal(mainnet?.network, "eip155:4217");
  // directory 全体でも落ちる
  const dir = parseMppDirectory({
    services: [{ serviceUrl: "https://a.example", realm: "a.example", endpoints: [
      { method: "GET", path: "/main", payment: { intent: "charge", method: "tempo", currency: USDC_E, amount: "1" } },
      { method: "GET", path: "/moderato", payment: { intent: "charge", method: "tempo", currency: USDC_E, amount: "1", chainId: 42431 } },
    ] }],
  });
  assert.deepEqual(dir.items.map((i) => i.resourceUrl), ["https://a.example/main"]);
  assert.equal(dir.endpointCount, 1);
  // NUL は落とす（Bazaar と同じ事故を繰り返さない）
  const nul = parseMppEndpoint(
    { serviceUrl: "https://a.example", realm: "a.example" },
    { method: "GET", path: "/x", description: "bad\u0000byte", payment: { intent: "charge", method: "tempo", currency: USDC_E, amount: "1" } },
  );
  assert.equal(nul?.description, "badbyte");
});

test("parseMppDirectory caps at MPP_DIRECTORY_MAX_ITEMS and reports complete=false when it cuts", () => {
  const endpoints = Array.from({ length: MPP_DIRECTORY_MAX_ITEMS + 5 }, (_, n) => ({
    method: "GET",
    path: `/e/${n}`,
    payment: { intent: "charge", method: "tempo", currency: USDC_E, decimals: 6, amount: "1000", unitType: "request" },
  }));
  const { items, endpointCount, complete } = parseMppDirectory({ services: [{ serviceUrl: "https://big.example", realm: "big.example", endpoints }] });
  assert.equal(items.length, MPP_DIRECTORY_MAX_ITEMS);
  assert.equal(endpointCount, MPP_DIRECTORY_MAX_ITEMS + 5);
  assert.equal(complete, false);
});

test("fetchMppDirectory: one fetch; ok → items/counts; non-ok or throw → empty and complete=false (no phantom delisting)", async () => {
  const urls: string[] = [];
  const ok = await fetchMppDirectory({
    url: "https://dir.example/api/services",
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(urls, ["https://dir.example/api/services"]);
  assert.equal(ok.items.length, 3);
  assert.equal(ok.totalCount, 3);
  assert.equal(ok.fetchedCount, 3);
  assert.equal(ok.complete, true);

  const down = await fetchMppDirectory({ url: "https://dir.example/api/services", fetchImpl: async () => new Response("nope", { status: 503 }) });
  assert.equal(down.items.length, 0);
  assert.equal(down.complete, false);
  const thrown = await fetchMppDirectory({
    url: "https://dir.example/api/services",
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(thrown.complete, false);
  assert.equal(MPP_DIRECTORY_SOURCE, "mpp_directory");
});
