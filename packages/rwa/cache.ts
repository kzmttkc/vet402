// The guard on the two key-less /rwa surfaces (SPEC §9).
//
// One reconstruction costs ~30 RPC calls and tens of seconds of wall time, and
// both the facts route and the /rwa page are open to anyone without a key. A
// per-address cache alone does not bound the cost: a caller walking distinct
// addresses gets a fresh reconstruction every time. So this module holds these
// limits, together, and both surfaces go through it:
//
//   1. the same address is reconstructed at most once per 5 minutes
//      (2026-09-23: raised from 60s at the core session's request, after the
//      2026-09-23 Vercel quota stop; the venue demo does not feel it)
//   2. at most 200 addresses are remembered, oldest evicted, so the map cannot
//      grow without bound
//   3. at most 1 reconstruction runs at once; a caller over the cap is told to
//      retry rather than being queued behind a long read (2026-09-28: lowered
//      from 3 after production showed three parallel reconstructions drawing
//      429s from the public RPC and all three failing)
//   4. a caller stops waiting after a deadline (45 s for the paid lane, 20 s for
//      the free route and the page) and is told to come back; the
//      reconstruction itself keeps its slot and runs on, so the retry finds the
//      answer instead of starting over (SPEC patch 020). A reconstruction that
//      is still running after 55 s gives its slot up, so a hung read cannot
//      block the instance
//   5. an address that holds no Stock Token, or too many to rebuild in one
//      request, is remembered like any other answer,
//      so pasting the same fresh wallet twice costs one read and says the same
//      thing twice (SPEC patch 020)
//
// A cached answer is always served, even while the in-flight cap is full.
import { NoStockTokenActivity, WalletTooLarge, reconstructFacts, type RwaFacts } from "./facts";

export const FACTS_CACHE_TTL_MS = 5 * 60_000;
export const FACTS_CACHE_MAX_ENTRIES = 200;
export const MAX_RECONSTRUCTIONS_IN_FLIGHT = 1;
/** How long the paid lane waits (unchanged by patch 020). */
export const RECONSTRUCTION_DEADLINE_MS = 45_000;
/** How long the free route and the /rwa page wait before answering "still reading" (patch 020). */
export const FREE_DEADLINE_MS = 20_000;
/** A reconstruction still running after this gives up its slot and its cache entry. */
export const RECONSTRUCTION_HARD_CAP_MS = 55_000;

/** Thrown when a reconstruction outlives RECONSTRUCTION_DEADLINE_MS. The surfaces answer 503 + Retry-After. */
export class ReconstructionTimeout extends Error {
  readonly retryAfterSec = 30;
  constructor() {
    super("reconstruction_timeout");
    this.name = "ReconstructionTimeout";
  }
}

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

function withDeadline<T>(p: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReconstructionTimeout()), deadlineMs);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** The cache itself, with the loader and the clock injected (the tests drive both). */
export async function cachedFactsWith<T>(
  address: string,
  load: (address: string) => Promise<T>,
  clock: () => number = Date.now,
  deadlineMs: number = RECONSTRUCTION_DEADLINE_MS,
  hardCapMs: number = RECONSTRUCTION_HARD_CAP_MS,
): Promise<T> {
  const key = address.toLowerCase();
  const now = clock();
  const hit = state.store.get(key);
  // A hit may still be running (an earlier caller stopped waiting): join it, under this caller's deadline.
  if (hit && hit.expiresAt > now) return withDeadline(hit.promise as Promise<T>, deadlineMs);

  if (state.inFlight >= MAX_RECONSTRUCTIONS_IN_FLIGHT) throw new TooBusy();
  state.inFlight++;
  evictIfNeeded(now);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.inFlight--;
  };
  const forget = () => {
    if (state.store.get(key)?.promise === loaded) state.store.delete(key);
  };
  const cap = setTimeout(() => {
    release();
    forget();
  }, hardCapMs);
  (cap as { unref?: () => void }).unref?.();

  const loaded: Promise<T> = load(key)
    .catch((err) => {
      // An empty or too-large answer is an answer and stays cached. A failure is not.
      if (!(err instanceof NoStockTokenActivity || err instanceof WalletTooLarge)) forget();
      throw err;
    })
    .finally(() => {
      clearTimeout(cap);
      release();
    });
  // Whoever stopped waiting, the outcome still lands in the cache without an unhandled rejection.
  loaded.catch(() => {});
  state.store.set(key, { promise: loaded, expiresAt: now + FACTS_CACHE_TTL_MS });
  return withDeadline(loaded, deadlineMs);
}

/** The entry for `address` while it exists, finished or not (the free route keeps the function alive on it). */
export function pendingFacts(address: string): Promise<unknown> | null {
  const hit = state.store.get(address.toLowerCase());
  return hit ? hit.promise.catch(() => {}) : null;
}

/**
 * Facts for `address`, under the limits above. The paid lane uses the default deadline.
 * `lookalikeEndBy` (epoch ms) reaches a reconstruction this call starts. A call that joins
 * one already running gets that one's record as it is.
 */
export function cachedFacts(address: string, opts: { deadlineMs?: number; lookalikeEndBy?: number } = {}): Promise<RwaFacts> {
  const load = (a: string) => reconstructFacts(a, opts.lookalikeEndBy === undefined ? {} : { lookalikeEndBy: opts.lookalikeEndBy });
  return cachedFactsWith(address, load, Date.now, opts.deadlineMs ?? RECONSTRUCTION_DEADLINE_MS);
}
