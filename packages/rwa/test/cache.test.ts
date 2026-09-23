// The guard on the two key-less /rwa surfaces (SPEC §9).
//
// A reconstruction costs ~30 RPC calls and tens of seconds of wall time, and
// both surfaces are open to anyone. Three limits, all in this module so the
// route and the page cannot diverge: a shared 5-minute per-address cache, a
// bounded number of cached addresses, and a cap on reconstructions in flight.
//
// Run from the repo root: npx tsx --test packages/rwa/test/cache.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  FACTS_CACHE_MAX_ENTRIES,
  FACTS_CACHE_TTL_MS,
  MAX_RECONSTRUCTIONS_IN_FLIGHT,
  TooBusy,
  __resetFactsCacheForTest,
  cachedFactsWith,
} from "../cache";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const deferred = () => {
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => __resetFactsCacheForTest());

test("the same address is reconstructed once inside the TTL and again after it", async () => {
  let calls = 0;
  let now = 1_000_000;
  const load = async () => { calls++; return { n: calls } as never; };
  const clock = () => now;
  await cachedFactsWith(addr(1), load, clock);
  await cachedFactsWith(addr(1), load, clock);
  assert.equal(calls, 1);
  now += FACTS_CACHE_TTL_MS + 1;
  await cachedFactsWith(addr(1), load, clock);
  assert.equal(calls, 2);
  assert.equal(FACTS_CACHE_TTL_MS, 5 * 60_000);
});

test("concurrent callers for one address share a single reconstruction", async () => {
  let calls = 0;
  const d = deferred();
  const load = async () => { calls++; return (await d.promise) as never; };
  const a = cachedFactsWith(addr(2), load);
  const b = cachedFactsWith(addr(2), load);
  d.resolve({ ok: true });
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
});

test("a failed reconstruction is not cached", async () => {
  let calls = 0;
  const load = async () => { calls++; throw new Error("rpc down"); };
  await assert.rejects(cachedFactsWith(addr(3), load), /rpc down/);
  await assert.rejects(cachedFactsWith(addr(3), load), /rpc down/);
  assert.equal(calls, 2);
});

test("the cache is bounded: a flood of distinct addresses evicts the oldest", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const load = async () => ({} as never);
  for (let i = 0; i < FACTS_CACHE_MAX_ENTRIES + 10; i++) {
    await cachedFactsWith(addr(100 + i), load, clock);
    now += 1;
  }
  let calls = 0;
  const counting = async () => { calls++; return {} as never; };
  await cachedFactsWith(addr(100), counting, clock); // evicted: reconstructed again
  await cachedFactsWith(addr(100 + FACTS_CACHE_MAX_ENTRIES + 9), counting, clock); // newest: still cached
  assert.equal(calls, 1);
});

test("reconstructions in flight are capped; the caller over the cap is told to retry", async () => {
  const gates = Array.from({ length: MAX_RECONSTRUCTIONS_IN_FLIGHT + 1 }, deferred);
  const started = gates.map((g, i) => cachedFactsWith(addr(200 + i), async () => (await g.promise) as never).catch((e) => e));
  const results = await Promise.all(started.slice(MAX_RECONSTRUCTIONS_IN_FLIGHT));
  assert.ok(results[0] instanceof TooBusy, `expected TooBusy, got ${results[0]}`);
  gates.forEach((g) => g.resolve({}));
  await Promise.all(started.slice(0, MAX_RECONSTRUCTIONS_IN_FLIGHT));
  // the slot is released, so the next caller gets through
  let calls = 0;
  await cachedFactsWith(addr(999), async () => { calls++; return {} as never; });
  assert.equal(calls, 1);
  assert.equal(MAX_RECONSTRUCTIONS_IN_FLIGHT, 3);
});

test("a cache hit is served even while the in-flight cap is full", async () => {
  const warm = deferred();
  const first = cachedFactsWith(addr(300), async () => (await warm.promise) as never);
  warm.resolve({ warm: true });
  await first;
  const blockers = Array.from({ length: MAX_RECONSTRUCTIONS_IN_FLIGHT }, deferred);
  const busy = blockers.map((g, i) => cachedFactsWith(addr(400 + i), async () => (await g.promise) as never));
  assert.deepEqual(await cachedFactsWith(addr(300), async () => { throw new Error("must not reconstruct"); }), { warm: true });
  blockers.forEach((g) => g.resolve({}));
  await Promise.all(busy);
});
