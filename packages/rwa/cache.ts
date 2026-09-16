// In-process facts cache shared by the facts route and the /rwa page (SPEC §9:
// the same address is served from cache for 60 seconds). Kept on globalThis so
// the route bundle and the page bundle see one map.
import { reconstructFacts, type RwaFacts } from "./facts";

export const FACTS_CACHE_TTL_MS = 60_000;

type Entry = { promise: Promise<RwaFacts>; expiresAt: number };
const store: Map<string, Entry> = ((globalThis as unknown as { __rwaFactsCache?: Map<string, Entry> }).__rwaFactsCache ??= new Map());

/** Facts for `address` (lower-cased), reconstructed at most once per 60s; concurrent callers share one reconstruction. */
export function cachedFacts(address: string): Promise<RwaFacts> {
  const key = address.toLowerCase();
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  const promise = reconstructFacts(key).catch((err) => {
    store.delete(key); // a failed reconstruction is not cached
    throw err;
  });
  store.set(key, { promise, expiresAt: now + FACTS_CACHE_TTL_MS });
  return promise;
}
