// ============================================================
// GET /api/v1/check（と decision 別名）の checkSeller 読み取りを最大 60 秒使い回す。
// 鍵は canonicalUrl（正規化 URL）と method を別要素。回数制限は keyless-check-route で先にかける。
// unstable_cache の期限後も古い値が返ることがあるので cacheReadAt で打ち切り、超えたらその場で読み直す。
// 読み直しに失敗したら古い値は返さず 503。失敗（throw）は unstable_cache に載せない。
// as_of は checkSeller が返した値のまま返す（キャッシュヒットでも「今」を付けない）。
// 鍵は api_key などを除いた URL なので、呼び手の生の URL を含む diagnose_url は保存せず、要求ごとに作る。
// 保存する本文は正規化した URL で読む（呼び手の長い URL が他の呼び手の一覧を削らない）。
// spending_halted: true は読み取り失敗でも出る安全側の値なので再利用しない（復旧後に停止中と答え続けない）。
// 期限の CHECK_SELLER_PREFETCH_LEAD_SECONDS 秒前から裏で読み直し（鮮度の決まりはそのまま——まだ fresh な応答を返す間だけ走る）。
// ============================================================
import { unstable_cache } from "next/cache";
import { diagnoseUrlFor } from "@/lib/api/diagnose-url";
import { canonicalUrl } from "@/lib/ids/canonical";
import { classifyQuery } from "@/lib/resolve/classify";
import type { CheckSellerOutput } from "@/lib/mcp/schemas";
import { checkSeller, type CheckSellerDeps } from "@/lib/mcp/tools";
import { isNoDataCacheError } from "@/lib/observatory/state-reads";
import { keepAliveUntilSettled } from "@/lib/util/after-response";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const CHECK_SELLER_CACHE_SECONDS = 60;
/** fresh な間、期限の何秒前から裏読みを始めるか（60 秒 TTL のうち後半で裏読みし、期限直前の表読みを避ける）。 */
export const CHECK_SELLER_PREFETCH_LEAD_SECONDS = 20;

/** unstable_cache のキー要素。https 以外・壊れた URL は null。 */
export function checkSellerCacheKeyParts(url: string, method?: string): readonly [string, string] | null {
  const c = canonicalUrl(url);
  if (!c) return null;
  const m = method ? method.toUpperCase() : "";
  return [c.url, m] as const;
}

/** 試験用: 正規化した URL と method の組（連結鍵は使わない）。 */
export function checkSellerCacheKey(url: string, method?: string): string | null {
  const parts = checkSellerCacheKeyParts(url, method);
  if (!parts) return null;
  return `${parts[0]}\0${parts[1]}`;
}

function storeKey(urlKey: string, methodKey: string): string {
  return `${urlKey}\0${methodKey}`;
}

export type CheckSellerCachedPayload = {
  out: CheckSellerOutput;
  /** この読み取りを始めた時刻（ISO8601 UTC）。再利用しない本文は空文字。応答には出さない。 */
  cacheReadAt: string;
  /** client_usage_daily_network 用。endpoint から分かった network（CAIP-2）。 */
  usageNetwork?: string;
};

export function isCheckSellerCachedReadFresh(
  cacheReadAt: string,
  nowMs: number = Date.now(),
): boolean {
  const readMs = Date.parse(cacheReadAt);
  if (!Number.isFinite(readMs)) return false;
  return nowMs - readMs <= CHECK_SELLER_CACHE_SECONDS * 1000;
}

export function stripCheckSellerCachedPayload(payload: CheckSellerCachedPayload): CheckSellerOutput {
  return payload.out;
}

/** JSON 経由で Date などを壊さない（unstable_cache のシリアライズと同じ形に固定する）。 */
export function checkSellerFreezeForCache(out: CheckSellerOutput): CheckSellerOutput {
  return JSON.parse(JSON.stringify(out)) as CheckSellerOutput;
}

/** 保存する形。呼び手ごとの値を落とす。 */
function checkSellerForStore(out: CheckSellerOutput): CheckSellerOutput {
  return out.not_in_catalog ? { ...out, diagnose_url: "" } : out;
}

/** 返す形。呼び手ごとの値をこの要求の URL から作る。 */
function checkSellerForCaller(out: CheckSellerOutput, url: string): CheckSellerOutput {
  return out.not_in_catalog ? { ...out, diagnose_url: diagnoseUrlFor(url) } : out;
}

function payloadFromFresh(
  fresh: Awaited<ReturnType<typeof readCheckSellerFresh>>,
  cacheReadAt: string,
): CheckSellerCachedPayload {
  return {
    out: checkSellerForStore(fresh.out),
    cacheReadAt: fresh.out.spending_halted === true ? "" : cacheReadAt,
    usageNetwork: fresh.usageNetwork,
  };
}

function deliverPrefetched(
  deps: CheckSellerDeps,
  payload: CheckSellerCachedPayload,
  callerUrl: string,
): CheckSellerOutput {
  if (payload.usageNetwork) deps.captureUsageNetwork?.(payload.usageNetwork);
  return checkSellerForCaller(stripCheckSellerCachedPayload(payload), callerUrl);
}

const prefetchedByStoreKey = new Map<string, CheckSellerCachedPayload>();
const prefetchInflight = new Map<string, Promise<void>>();
const freshInflight = new Map<string, Promise<{ out: CheckSellerOutput; usageNetwork?: string }>>();

/** 裏読みの持ち数の上限。超えたら古い順に捨てる（URL ごとに増え続けない）。 */
const PREFETCH_MAX_ENTRIES = 256;

function rememberPrefetched(storeK: string, payload: CheckSellerCachedPayload): void {
  prefetchedByStoreKey.delete(storeK);
  while (prefetchedByStoreKey.size >= PREFETCH_MAX_ENTRIES) {
    const oldest = prefetchedByStoreKey.keys().next().value;
    if (oldest === undefined) break;
    prefetchedByStoreKey.delete(oldest);
  }
  prefetchedByStoreKey.set(storeK, payload);
}

/** テスト用: 裏読み・同時リフレッシュの状態を消す。 */
export function __resetCheckSellerLatencyHelpersForTests(): void {
  prefetchedByStoreKey.clear();
  prefetchInflight.clear();
  freshInflight.clear();
}

/** 試験用: 裏読みが載せた payload を注入する。 */
export function prefetchedByStoreKeyForTests(key: string, payload: CheckSellerCachedPayload): void {
  prefetchedByStoreKey.set(key, payload);
}

/** 試験用: 裏読みが走り途中のときに表が待つ経路を再現する。 */
export function prefetchInflightForTests(storeK: string, work: Promise<void>): void {
  prefetchInflight.set(storeK, work);
}

type CacheFn = typeof unstable_cache;

export type CheckSellerCachePath = "direct" | "fresh" | "prefetch" | "coalesced";

export type CheckSellerCacheTiming = {
  path?: CheckSellerCachePath;
};

export type GetCheckSellerCached = (
  deps: CheckSellerDeps,
  input: { url: string; method?: string },
  timing?: CheckSellerCacheTiming,
) => Promise<CheckSellerOutput>;

async function readCheckSellerFresh(
  deps: CheckSellerDeps,
  input: { url: string; method?: string },
): Promise<{ out: CheckSellerOutput; usageNetwork?: string }> {
  let usageNetwork: string | undefined;
  const wrapped: CheckSellerDeps = {
    ...deps,
    captureUsageNetwork: (network) => {
      usageNetwork = network;
    },
  };
  const out = checkSellerFreezeForCache(await checkSeller(wrapped, input));
  return { out, usageNetwork };
}

function finishFreshRead(deps: CheckSellerDeps, fresh: Awaited<ReturnType<typeof readCheckSellerFresh>>): CheckSellerOutput {
  if (fresh.usageNetwork) deps.captureUsageNetwork?.(fresh.usageNetwork);
  return fresh.out;
}

async function coalescedFreshRead(
  deps: CheckSellerDeps,
  input: { url: string; method?: string },
  inflightKey: string,
): Promise<Awaited<ReturnType<typeof readCheckSellerFresh>>> {
  const pending = freshInflight.get(inflightKey);
  if (pending) return pending;
  type Fresh = Awaited<ReturnType<typeof readCheckSellerFresh>>;
  let release!: (value: Fresh) => void;
  let fail!: (error: unknown) => void;
  const slot = new Promise<Fresh>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  freshInflight.set(inflightKey, slot);
  void readCheckSellerFresh(deps, input).then(
    (value) => {
      freshInflight.delete(inflightKey);
      release(value);
    },
    (error) => {
      freshInflight.delete(inflightKey);
      fail(error);
    },
  );
  return slot;
}

/** 同じ鍵の読み直しを1本にまとめ、diagnose_url はこの要求の URL から作り直す（他の呼び手の URL を返さない）。 */
async function coalescedForCaller(
  deps: CheckSellerDeps,
  callerUrl: string,
  urlKey: string,
  methodKey: string,
  storeK: string,
): Promise<CheckSellerOutput> {
  const fresh = await coalescedFreshRead(deps, { url: urlKey, method: methodKey || undefined }, storeK);
  return checkSellerForCaller(checkSellerForStore(finishFreshRead(deps, fresh)), callerUrl);
}

function scheduleCheckSellerPrefetch(
  deps: CheckSellerDeps,
  storeK: string,
  urlKey: string,
  methodKey: string,
  cacheReadAt: string,
  warmUnstableCache: () => Promise<CheckSellerCachedPayload>,
): void {
  const readMs = Date.parse(cacheReadAt);
  if (!Number.isFinite(readMs)) return;
  const leadMs = CHECK_SELLER_PREFETCH_LEAD_SECONDS * 1000;
  if (Date.now() - readMs < CHECK_SELLER_CACHE_SECONDS * 1000 - leadMs) return;
  if (prefetchInflight.has(storeK)) return;
  const work = (async () => {
    try {
      const cacheReadStarted = new Date().toISOString();
      const fresh = await readCheckSellerFresh(deps, { url: urlKey, method: methodKey || undefined });
      const payload = payloadFromFresh(fresh, cacheReadStarted);
      if (isCheckSellerCachedReadFresh(payload.cacheReadAt)) {
        rememberPrefetched(storeK, payload);
      }
      await warmUnstableCache().catch(() => undefined);
    } catch {
      // 裏読みの失敗は呼び手に出さない。期限後はその場で読み直す。
    } finally {
      prefetchInflight.delete(storeK);
    }
  })();
  prefetchInflight.set(storeK, work);
  keepAliveUntilSettled(work);
}

function markPath(timing: CheckSellerCacheTiming | undefined, path: CheckSellerCachePath): void {
  if (timing) timing.path = path;
}

async function deliverPrefetchOrWait(
  deps: CheckSellerDeps,
  storeK: string,
  callerUrl: string,
  timing: CheckSellerCacheTiming | undefined,
): Promise<CheckSellerOutput | null> {
  const prefetched = prefetchedByStoreKey.get(storeK);
  if (prefetched) prefetchedByStoreKey.delete(storeK);
  if (prefetched && isCheckSellerCachedReadFresh(prefetched.cacheReadAt)) {
    markPath(timing, "prefetch");
    return deliverPrefetched(deps, prefetched, callerUrl);
  }
  const inflight = prefetchInflight.get(storeK);
  if (!inflight) return null;
  await inflight;
  return deliverPrefetchOrWait(deps, storeK, callerUrl, timing);
}

export function makeGetCheckSellerCached(cache: CacheFn): GetCheckSellerCached {
  return async (deps, input, timing) => {
    const parts = checkSellerCacheKeyParts(input.url, input.method);
    // 正規化で伸びて照会の上限を超える URL は、正規化した形では引けないのでキャッシュを通さない。
    if (parts === null || classifyQuery(parts[0]).kind !== "url") {
      markPath(timing, "direct");
      return finishFreshRead(deps, await readCheckSellerFresh(deps, input));
    }

    const [urlKey, methodKey] = parts;
    const storeK = storeKey(urlKey, methodKey);
    const read = cache(
      async (): Promise<CheckSellerCachedPayload> => {
        // 読み始めの時刻で数える。読み終わりで数えると、読み取りにかかった分だけ 60 秒を超える。
        const cacheReadAt = new Date().toISOString();
        const fresh = await readCheckSellerFresh(deps, { ...input, url: urlKey });
        return payloadFromFresh(fresh, cacheReadAt);
      },
      ["check-seller:v2", urlKey, methodKey],
      { revalidate: CHECK_SELLER_CACHE_SECONDS, tags: ["check-seller"] },
    );

    try {
      const cached = await read();
      if (isCheckSellerCachedReadFresh(cached.cacheReadAt)) {
        markPath(timing, "fresh");
        scheduleCheckSellerPrefetch(deps, storeK, urlKey, methodKey, cached.cacheReadAt, read);
        if (cached.usageNetwork) deps.captureUsageNetwork?.(cached.usageNetwork);
        return checkSellerForCaller(stripCheckSellerCachedPayload(cached), input.url);
      }

      const prefetched = await deliverPrefetchOrWait(deps, storeK, input.url, timing);
      if (prefetched) return prefetched;

      markPath(timing, "coalesced");
      return coalescedForCaller(deps, input.url, urlKey, methodKey, storeK);
    } catch (error) {
      if (isNoDataCacheError(error)) {
        markPath(timing, "coalesced");
        return coalescedForCaller(deps, input.url, urlKey, methodKey, storeK);
      }
      logServerErrorSafe("check_seller_cache", error);
      throw error;
    }
  };
}

let getCheckSellerCached = makeGetCheckSellerCached(unstable_cache);

/** テストの差し替え口。null で本番の unstable_cache に戻す。 */
export function __setCheckSellerCacheForTests(cache: CacheFn | null): void {
  getCheckSellerCached = makeGetCheckSellerCached(cache ?? unstable_cache);
}

export { getCheckSellerCached };