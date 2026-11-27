// ============================================================
// 版管理された予約購入（pinned-purchases.ts）の検証と並び。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import {
  PINNED_PURCHASES,
  PINNED_PURCHASE_SELECTION,
  listingMatchesPinned,
  fetchPinnedCandidateRows,
  PINNED_FETCHES_PER_BATCH,
  PINNED_QUERIES_PER_BATCH,
  PINNED_NETWORK_LANES,
  dropLaneCandidatesShadowedByNetworkPins,
  pinnedLaneChainOf,
  type ActivePinnedTarget,
  loadActivePinnedPurchaseTargets,
  pinnedPurchaseMetaOf,
  pinnedPurchasesActiveAt,
  pinnedWindowActive,
  promotePinnedPurchaseCandidates,
  validatePinnedPurchase,
  validatePinnedPurchaseList,
  type PinnedPurchase,
} from "@/lib/observatory/pinned-purchases";

const SAMPLE: PinnedPurchase = {
  url: "https://example.com/api/x",
  method: "GET",
  from: "2027-01-11T00:00:00.000Z",
  to: "2027-01-12T23:59:59.999Z",
  reason: "test",
  requestedBy: "unit",
  approvedAt: "2026-11-22T22:20:00.000Z",
  maxPurchases: 1,
};

test("PINNED_PURCHASES validates at load and includes weather-forecast", () => {
  validatePinnedPurchaseList(PINNED_PURCHASES);
  const wf = PINNED_PURCHASES.find((p) => p.url.includes("weather-forecast"));
  assert.ok(wf);
  assert.equal(wf.method, "GET");
  assert.equal(wf.maxPurchases, 1);
});

test("prezenti-m2 usebuy reservations were removed on 2026-11-25", () => {
  assert.equal(PINNED_PURCHASES.filter((p) => p.reason === "prezenti-m2-usebuy-2611").length, 0);
  assert.equal(PINNED_PURCHASES.filter((p) => p.url.startsWith("https://gateway.usebuy.ai/")).length, 0);
});

test("validatePinnedPurchase rejects bad rows", () => {
  assert.throws(() => validatePinnedPurchase({ ...SAMPLE, url: "http://bad" }, 0), /https/);
  assert.throws(() => validatePinnedPurchase({ ...SAMPLE, from: SAMPLE.to, to: SAMPLE.from }, 0), /before to/);
  assert.throws(() => validatePinnedPurchase({ ...SAMPLE, maxPurchases: 0 }, 0), /maxPurchases/);
  assert.throws(() => validatePinnedPurchase({ ...SAMPLE, reason: "" }, 0), /reason/);
  assert.throws(() => validatePinnedPurchase({ ...SAMPLE, approvedAt: "" }, 0), /approvedAt/);
});

test("pinned window: inside, outside, and after max conceptually", () => {
  const inside = Date.parse("2027-01-12T12:00:00.000Z");
  const before = Date.parse("2027-01-10T23:00:00.000Z");
  const after = Date.parse("2027-01-13T00:00:00.000Z");
  assert.equal(pinnedWindowActive(SAMPLE, inside), true);
  assert.equal(pinnedWindowActive(SAMPLE, before), false);
  assert.equal(pinnedWindowActive(SAMPLE, after), false);
  // 本物の一覧は、その行の from から時刻を作る（期間を動かしても試験が追従する）。
  const real = PINNED_PURCHASES.find((p) => p.url.includes("weather-forecast"))!;
  const realInside = Date.parse(real.from) + 12 * 3600_000;
  const realBefore = Date.parse(real.from) - 3600_000;
  const realAfter = Date.parse(real.to) + 1;
  assert.ok(pinnedPurchasesActiveAt(realInside).some((p) => p.url.includes("weather-forecast")));
  assert.equal(pinnedPurchasesActiveAt(realBefore).length, 0);
  assert.equal(pinnedPurchasesActiveAt(realAfter).length, 0);
});

test("listingMatchesPinned uses canonical https URLs", () => {
  assert.equal(
    listingMatchesPinned(SAMPLE, "https://example.com/api/x/", "get"),
    true,
  );
  assert.equal(listingMatchesPinned(SAMPLE, "https://other.example/api/x", "GET"), false);
  assert.equal(listingMatchesPinned({ ...SAMPLE, method: "POST" }, "https://example.com/api/x", "GET"), false);
});

test("promotePinnedPurchaseCandidates puts pinned first when active", () => {
  const a = { id: "a", resourceUrl: "https://a", method: "GET", selection: null as string | null };
  const b = { id: "b", resourceUrl: "https://b", method: "GET", selection: null as string | null };
  const targets = [{ entry: SAMPLE, endpointId: "b", settledCount: 0 }];
  const out = promotePinnedPurchaseCandidates([a, b], targets, (c, t) => ({
    ...c,
    selection: PINNED_PURCHASE_SELECTION,
    pinnedPurchaseMeta: pinnedPurchaseMetaOf(t.entry),
  }));
  assert.equal(out[0].id, "b");
  assert.equal(out[1].id, "a");
  assert.equal(out[0].selection, PINNED_PURCHASE_SELECTION);
});

test("promotePinnedPurchaseCandidates is unchanged outside window (no targets)", () => {
  const list = [{ id: "x", resourceUrl: "https://x", method: "GET", selection: null as string | null }];
  assert.deepEqual(promotePinnedPurchaseCandidates(list, [], (c) => c), list);
});

test("weather-forecast: the window holds both 12:00 UTC cron runs before judging (01-10 and 01-11) and closes before judging opens", () => {
  const at = (iso: string) => pinnedPurchasesActiveAt(Date.parse(iso)).some((p) => p.url.includes("weather-forecast"));
  assert.equal(at("2027-01-10T12:00:00.000Z"), true);
  assert.equal(at("2027-01-11T12:00:00.000Z"), true);
  assert.equal(at("2027-01-11T18:00:00.000Z"), false);
  const wf = PINNED_PURCHASES.find((p) => p.url.includes("weather-forecast"))!;
  assert.equal(wf.maxPurchases, 1);
});

test("loadActivePinnedPurchaseTargets: two queries for many pins (endpoints once, counts once per window start), same matches and caps (2026-11-27)", async () => {
  const pins: PinnedPurchase[] = Array.from({ length: 300 }, (_, i) => ({ ...SAMPLE, url: `https://example.com/api/p${i}`, method: i % 2 ? "POST" : "GET" }));
  const rows = pins.map((p, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, resource_url: p.url, method: p.method }));
  // p0 already bought once (at maxPurchases 1), p1 listed with the other method only, p2 not listed.
  rows[1] = { ...rows[1]!, method: "GET" };
  rows.splice(2, 1);
  let calls = 0;
  const db = {
    execute: async (q: unknown) => {
      calls++;
      const text = JSON.stringify(q);
      if (text.includes("x402_endpoints")) return { rows };
      return { rows: [{ id: rows[0]!.id, n: 1 }] };
    },
  } as unknown as Parameters<typeof loadActivePinnedPurchaseTargets>[0];
  const now = Date.parse("2027-01-11T12:00:00.000Z");
  const out = await loadActivePinnedPurchaseTargets(db, now, pins);
  assert.equal(calls, 2);
  const urls = new Set(out.map((t) => t.entry.url));
  assert.equal(urls.has(pins[0]!.url), false, "bought already");
  assert.equal(urls.has(pins[1]!.url), false, "method differs");
  assert.equal(urls.has(pins[2]!.url), false, "not listed");
  assert.equal(out.length, 297);
  assert.equal(out[0]!.entry.url, pins[3]!.url, "list order kept");
  assert.deepEqual(await loadActivePinnedPurchaseTargets(db, Date.parse("2026-01-01T00:00:00.000Z"), pins), []);
});

// ---- 2026-11-26 の再発防止: 予約の件数に比例して準備の問い合わせが増えない（349 件・1,000 件） ----
const manyPins = (n: number): PinnedPurchase[] =>
  Array.from({ length: n }, (_, i) => ({ ...SAMPLE, url: `https://example.com/api/q${i}` }));

for (const n of [349, 1000]) {
  test(`setup queries do not grow with the reservation count: ${n} reservations`, async () => {
    const pins = manyPins(n);
    const rows = pins.map((p, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, resource_url: p.url, method: p.method }));
    let calls = 0;
    const db = {
      execute: async (q: unknown) => {
        calls++;
        return JSON.stringify(q).includes("x402_endpoints") ? { rows } : { rows: [] };
      },
    } as unknown as Parameters<typeof loadActivePinnedPurchaseTargets>[0];
    const nowMs = Date.parse("2027-01-11T12:00:00.000Z");
    const targets = await loadActivePinnedPurchaseTargets(db, nowMs, pins);
    assert.equal(targets.length, n);
    assert.equal(calls, 2, "the list is read in 2 queries whatever its size");

    // Every reservation becomes a candidate: at most PINNED_FETCHES_PER_BATCH queries.
    let q1 = 0;
    const all = await fetchPinnedCandidateRows(targets, new Set(), nowMs, async (t) => (q1++, { id: t.endpointId }));
    assert.equal(all.rows.length, PINNED_FETCHES_PER_BATCH);
    assert.equal(q1, PINNED_FETCHES_PER_BATCH);
    // None becomes a candidate: the queries stop at PINNED_QUERIES_PER_BATCH.
    let q2 = 0;
    const none = await fetchPinnedCandidateRows(targets, new Set(), nowMs, async () => (q2++, null));
    assert.equal(none.rows.length, 0);
    assert.equal(q2, PINNED_QUERIES_PER_BATCH);
    assert.equal(none.queries, PINNED_QUERIES_PER_BATCH);
  });
}

test("pinned fetch: the start moves by PINNED_FETCHES_PER_BATCH each UTC day, so a stuck head does not hold the list", async () => {
  const targets: ActivePinnedTarget[] = manyPins(349).map((entry, i) => ({ entry, endpointId: `id-${i}`, settledCount: 0 }));
  const day = 86_400_000;
  const base = Math.floor(Date.parse("2027-01-11T12:00:00.000Z") / day) * day;
  const first = async (ms: number) => (await fetchPinnedCandidateRows(targets, new Set(), ms, async (t) => t.endpointId)).rows[0];
  const a = await first(base);
  const b = await first(base + day);
  assert.notEqual(a, b);
  const ia = Number(a!.slice(3));
  assert.equal(Number(b!.slice(3)), (ia + PINNED_FETCHES_PER_BATCH) % targets.length);
});

test("l1-runner fetches reservations only through fetchPinnedCandidateRows (no per-reservation loop in the runner)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/observatory/l1-runner.ts", import.meta.url), "utf8");
  assert.match(src, /fetchPinnedCandidateRows\(pinTargets/);
  assert.doesNotMatch(src, /for \(const t of pinTargets\)/);
  assert.match(src, /setupOverHalfBudget = true/);
});

// ---- 2026-11-27: network を書いた予約（Prezenti M3・x402atlas.xyz を Celo で） ----
const CELO_PIN: PinnedPurchase = { ...SAMPLE, url: "https://seller.example/api/cheap", network: "eip155:42220" };

test("network pins: only PINNED_NETWORK_LANES networks validate, and they map to the lane", () => {
  assert.deepEqual(PINNED_NETWORK_LANES, { "eip155:42220": "celo" });
  validatePinnedPurchase(CELO_PIN, 0);
  assert.equal(pinnedLaneChainOf(CELO_PIN), "celo");
  assert.equal(pinnedLaneChainOf(SAMPLE), null);
  assert.throws(() => validatePinnedPurchase({ ...SAMPLE, network: "eip155:8453" }, 0), /network must be one of eip155:42220/);
  assert.throws(() => validatePinnedPurchase({ ...SAMPLE, network: "celo" }, 0), /network must be one of/);
});

test("prezenti-m3 x402atlas: four listings, 1 each on Celo, window 11-27..11-29 UTC", () => {
  const rows = PINNED_PURCHASES.filter((p) => p.reason === "prezenti-m3-celo-x402atlas");
  assert.deepEqual(
    rows.map((p) => `${p.method} ${p.url}`),
    [
      "GET https://x402atlas.xyz/api/chain/block-number",
      "POST https://x402atlas.xyz/v1/chat/completions",
      "GET https://x402atlas.xyz/api/chain/erc20-balance",
      "GET https://x402atlas.xyz/api/chain/erc721-tokens",
    ],
  );
  for (const p of rows) {
    assert.equal(p.network, "eip155:42220");
    assert.equal(p.maxPurchases, 1);
    assert.equal(p.requestedBy, "grants session (Prezenti M3)");
    assert.equal(pinnedWindowActive(p, Date.parse("2026-11-27T06:00:00.000Z")), true);
    assert.equal(pinnedWindowActive(p, Date.parse("2026-11-29T18:00:00.000Z")), true);
    assert.equal(pinnedWindowActive(p, Date.parse("2026-11-30T00:00:00.000Z")), false);
  }
  // 頭に置く（pay.sh の 349 件より前）: 予約の並びは先頭から買われる。
  const firstPaysh = PINNED_PURCHASES.findIndex((p) => p.reason === "presign-gate-2611");
  assert.ok(PINNED_PURCHASES.indexOf(rows[3]!) < firstPaysh);
});

test("pinned fetch: network pins are looked up first whatever the daily start", async () => {
  const targets: ActivePinnedTarget[] = [
    { entry: CELO_PIN, endpointId: "celo-0", settledCount: 0 },
    ...manyPins(349).map((entry, i) => ({ entry, endpointId: `id-${i}`, settledCount: 0 })),
  ];
  const day = 86_400_000;
  for (let d = 0; d < 12; d++) {
    const ms = Date.parse("2026-11-27T06:00:00.000Z") + d * day;
    const { rows } = await fetchPinnedCandidateRows(targets, new Set(), ms, async (t) => t.endpointId);
    assert.equal(rows[0], "celo-0");
    assert.equal(rows.length, PINNED_FETCHES_PER_BATCH);
  }
  // 主候補に既にあれば引かない（従来どおり）。
  const again = await fetchPinnedCandidateRows(targets, new Set(["celo-0"]), Date.parse("2026-11-27T06:00:00.000Z"), async (t) => t.endpointId);
  assert.equal(again.rows.includes("celo-0"), false);
});

test("lane candidates of a network-pinned host are dropped during the window, others are kept", () => {
  const list = [CELO_PIN];
  const inWindow = Date.parse("2027-01-11T12:00:00.000Z");
  const cands = [
    { id: "pin", resourceUrl: "https://seller.example/api/cheap", laneChain: "celo" },
    { id: "dear", resourceUrl: "https://Seller.example/v1/images", laneChain: "celo" },
    { id: "base", resourceUrl: "https://seller.example/v1/images", laneChain: null },
    { id: "arb", resourceUrl: "https://seller.example/v1/images", laneChain: "arbitrum" },
    { id: "other", resourceUrl: "https://other.example/x", laneChain: "celo" },
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  assert.deepEqual(ids(dropLaneCandidatesShadowedByNetworkPins(cands, inWindow, new Set(["pin"]), list)), ["pin", "base", "arb", "other"]);
  // 予約が届いた後（pinnedIds に無い）も窓のあいだは同じホストの Celo の枠を外す。
  assert.deepEqual(ids(dropLaneCandidatesShadowedByNetworkPins(cands, inWindow, new Set(), list)), ["base", "arb", "other"]);
  // 窓の外、network の無い予約だけのときは何も外さない。
  assert.deepEqual(ids(dropLaneCandidatesShadowedByNetworkPins(cands, Date.parse("2027-02-01T00:00:00.000Z"), new Set(), list)), ids(cands));
  assert.deepEqual(ids(dropLaneCandidatesShadowedByNetworkPins(cands, inWindow, new Set(), [SAMPLE])), ids(cands));
});

test("l1-runner puts network pins on their lane and drops shadowed lane candidates", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/observatory/l1-runner.ts", import.meta.url), "utf8");
  assert.match(src, /laneChain: pinnedLaneChainOf\(t\.entry\) \?\? c\.laneChain/);
  assert.match(src, /dropLaneCandidatesShadowedByNetworkPins\(candidates, now\(\)/);
});
