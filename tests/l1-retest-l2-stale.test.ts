// ============================================================
// Re-buy of a listing whose latest delivery missed declared keys and whose last attempt is older than 30 days.
// Pure parts: which rows still read as a named-key mismatch, and where the plan puts them.
// The SQL and the purchase path are in tests/l1-retest-l2-stale.pg.test.ts.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETEST_L2_STALE_PER_RUN, l2StaleListingIds, planCensusAndRetest } from "@/lib/observatory/l1-runner";

const SCHEMA = { properties: { output: { properties: { example: { required: ["a", "b"], properties: { a: {}, b: {} } } } } } };
const row = (over: Record<string, unknown> = {}) => ({
  endpoint_id: "ep-1",
  l2_schema: "mismatch",
  l2_detail: { missing: ["b"], responseHash: "h", reason: "missing_keys" },
  body_head: '{"a":1}',
  content_type: "application/json",
  declared_schema: SCHEMA,
  ...over,
});

test("a row that records the missing keys is picked", () => {
  assert.deepEqual(l2StaleListingIds([row()]), ["ep-1"]);
});

test("no named key means no BLOCK, so no priority", () => {
  assert.deepEqual(l2StaleListingIds([row({ l2_detail: { missing: [], responseHash: "h", reason: "unparseable" } })]), []);
  assert.deepEqual(l2StaleListingIds([row({ l2_detail: null })]), []);
});

test("a row without a response hash reads as unexplained in the decision, so it is not picked", () => {
  assert.deepEqual(l2StaleListingIds([row({ l2_detail: { missing: ["b"], reason: "missing_keys" } })]), []);
});

test("old rows go through legacyL2SchemaOf: a body cut before the key was seen is not a named-key mismatch", () => {
  const cut = `{"b":"${"x".repeat(600)}`;
  assert.deepEqual(
    l2StaleListingIds([row({ l2_detail: { missing: ["b"], responseHash: "h" }, body_head: cut.slice(0, 500) })]),
    [],
  );
});

test("an old row with a whole body that really misses the key is picked", () => {
  assert.deepEqual(l2StaleListingIds([row({ l2_detail: { missing: ["b"], responseHash: "h" }, body_head: '{"a":1}' })]), ["ep-1"]);
});

test("an old row with a whole body that has every key is not picked", () => {
  assert.deepEqual(l2StaleListingIds([row({ l2_detail: { missing: ["b"], responseHash: "h" }, body_head: '{"a":1,"b":2}' })]), []);
});

test("an id repeated in the rows comes back once, and a non-mismatch row is ignored", () => {
  assert.deepEqual(l2StaleListingIds([row(), row(), row({ endpoint_id: "ep-2", l2_schema: "match" })]), ["ep-1"]);
});

const cand = (id: string, host: string, price = "1000") => ({
  id,
  resource_url: `https://${host}/api/${id}`,
  method: "GET",
  price_amount: price,
  pay_to: "0x1111111111111111111111111111111111111111",
  network: "eip155:8453",
  declared_schema: null,
  is_priority: false,
  is_mature: false,
  settled_networks: [],
  failed_networks: [],
  xrpl_declared_pay_tos: [],
  arc_declared_accepts: [],
  census_price: price,
  census_host: host,
});
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => cand(`${prefix}${i}`, `${prefix}${i}.example`));
const planInput = {
  censusOn: true,
  retestOn: true,
  perRun: 40,
  excludeIds: new Set<string>(),
  fetchCensus: async (limit: number) => many("c", 60).slice(0, limit),
  fetchRetest: async (limit: number) => many("r", 60).slice(0, limit),
};

test("the plan puts them first, up to the per-run limit, ahead of the census minimum", async () => {
  const asked: number[] = [];
  const plan = await planCensusAndRetest({
    ...planInput,
    censusMin: 35,
    l2StaleOn: true,
    fetchL2Stale: async (limit: number) => (asked.push(limit), many("s", 10).slice(0, limit)),
  });
  assert.ok(RETEST_L2_STALE_PER_RUN >= 1 && RETEST_L2_STALE_PER_RUN <= 5);
  assert.deepEqual(asked, [RETEST_L2_STALE_PER_RUN]);
  assert.deepEqual(plan.head.slice(0, RETEST_L2_STALE_PER_RUN).map((c) => c.id), many("s", RETEST_L2_STALE_PER_RUN).map((c) => c.id));
  assert.ok(plan.head.slice(0, RETEST_L2_STALE_PER_RUN).every((c) => c.selection === "retest"));
  assert.equal(plan.head.length, 40, "the 40 per run limit still holds");
  assert.equal(plan.retestCount + plan.censusCount, 40);
  assert.equal(plan.head.filter((c) => c.id.startsWith("c")).length, 35, "the census minimum still fits");
});

test("a listing already in the lane head is not taken again, and the next one gets the slot", async () => {
  const asked: number[] = [];
  const plan = await planCensusAndRetest({
    ...planInput,
    censusOn: false,
    retestOn: false,
    censusMin: 0,
    excludeIds: new Set(["s0"]),
    l2StaleOn: true,
    fetchL2Stale: async (limit: number) => (asked.push(limit), many("s", 2)),
  });
  assert.deepEqual(asked, [RETEST_L2_STALE_PER_RUN + 1], "asks for one more so the overlap does not shrink the batch");
  assert.deepEqual(plan.head.map((c) => c.id), ["s1"]);
  assert.equal(plan.retestCount, 1);
});

test("the same seller is not bought twice in one run", async () => {
  const plan = await planCensusAndRetest({
    ...planInput,
    censusMin: 0,
    l2StaleOn: true,
    fetchL2Stale: async () => [cand("s0", "shared.example")],
    fetchRetest: async () => [cand("r0", "shared.example"), cand("r1", "other.example")],
  });
  assert.deepEqual(plan.head.filter((c) => c.id === "s0" || c.id.startsWith("r")).map((c) => c.id), ["s0", "r1"]);
});

test("off or absent: the plan is the same as before and never fetches", async () => {
  let called = 0;
  const off = await planCensusAndRetest({ ...planInput, censusMin: 5, l2StaleOn: false, fetchL2Stale: async () => (called++, []) });
  const absent = await planCensusAndRetest({ ...planInput, censusMin: 5 });
  assert.equal(called, 0);
  assert.deepEqual(off.head.map((c) => c.id), absent.head.map((c) => c.id));
  assert.equal(absent.head[0].id, "c0");
});

test("a price above what is left today is not taken", async () => {
  const plan = await planCensusAndRetest({
    ...planInput,
    censusOn: false,
    retestOn: false,
    censusMin: 0,
    maxPriceUnits: 500n,
    l2StaleOn: true,
    fetchL2Stale: async () => [cand("s0", "s0.example", "600"), cand("s1", "s1.example", "400")],
  });
  assert.deepEqual(plan.head.map((c) => c.id), ["s1"]);
});
