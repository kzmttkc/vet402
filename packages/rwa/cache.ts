// The guard on the two key-less /rwa surfaces (SPEC §9).
//
// One reconstruction costs ~30 RPC calls and tens of seconds of wall time, and
// both the facts route and the /rwa page are open to anyone without a key. A
// per-address cache alone does not bound the cost: a caller walking distinct
// addresses gets a fresh reconstruction every time. So this module holds three
// limits, together, and both surfaces go through it:
//
//   1. the same address is reconstructed at most once per 5 minutes
//      (2026-09-23: raised from 60s at the core session's request, after the
//      2026-09-23 Vercel quota stop; the venue demo does not feel it)
//   2. at most 200 addresses are remembered, oldest evicted, so the map cannot
//      grow without bound
//   3. at most 3 reconstructions run at once; a caller over the cap is told to
//      retry rather than being queued behind a 40-second read
//
// A cached answer is always served, even while the in-flight cap is full.
import { reconstructFacts, type RwaFacts } from "./facts";

export const FACTS_CACHE_TTL_MS = 5 * 60_000;
export const FACTS_CACHE_MAX_ENTRIES = 200;
export const MAX_RECONSTRUCTIONS_IN_FLIGHT = 3;

/** Thrown when too many reconstructions are already running. The surfaces answer 503 + Retry-After. */
export class TooBusy extends Error {
  readonly retryAfterSec = 30;
  constructor() {
    super("too_busy");
    this.name = "TooBusy";
  }
}

type Entry = { promise: Promise<unknown>; expiresAt: number };
type State = { store: Map<string, Entry>; inFlight: number };

const state: State = ((globalThis as unknown as { __rwaFactsCache?: State }).__rwaFactsCache ??= {
  store: new Map(),
  inFlight: 0,
});

/** Test seam: forget every cached address and release the in-flight counter. */
export function __resetFactsCacheForTest(): void {
  state.store.clear();
  state.inFlight = 0;
}

function evictIfNeeded(now: number): void {
  for (const [key, entry] of state.store) {
    if (entry.expiresAt <= now) state.store.delete(key);
  }
  // Map iterates in insertion order, so the first key is the oldest write.
  while (state.store.size >= FACTS_CACHE_MAX_ENTRIES) {
    const oldest = state.store.keys().next();
    if (oldest.done) break;
    state.store.delete(oldest.value);
  }
}

/** The cache itself, with the loader and the clock injected (the tests drive both). */
export async function cachedFactsWith<T>(
  address: string,
  load: (address: string) => Promise<T>,
  clock: () => number = Date.now,
): Promise<T> {
  const key = address.toLowerCase();
  const now = clock();
  const hit = state.store.get(key);
  if (hit && hit.expiresAt > now) return hit.promise as Promise<T>;

  if (state.inFlight >= MAX_RECONSTRUCTIONS_IN_FLIGHT) throw new TooBusy();
  state.inFlight++;

  evictIfNeeded(now);
  const promise = load(key)
    .catch((err) => {
      state.store.delete(key); // a failed reconstruction is not cached
      throw err;
    })
    .finally(() => {
      state.inFlight--;
    });
  state.store.set(key, { promise, expiresAt: now + FACTS_CACHE_TTL_MS });
  return promise;
}

/** Facts for `address`, under the three limits above. */
export function cachedFacts(address: string): Promise<RwaFacts> {
  return cachedFactsWith(address, reconstructFacts);
}
