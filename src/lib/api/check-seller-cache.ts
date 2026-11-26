// ============================================================
// GET /api/v1/check（と decision 別名）の checkSeller 読み取りを最大 60 秒使い回す。
// 鍵は canonicalUrl（正規化 URL）と method を別要素。回数制限は keyless-check-route で先にかける。
// unstable_cache の期限後も古い値が返ることがあるので cacheReadAt で打ち切り、超えたらその場で読み直す。
// 読み直しに失敗したら古い値は返さず 503。失敗（throw）は unstable_cache に載せない。
// as_of は checkSeller が返した値のまま返す（キャッシュヒットでも「今」を付けない）。
// 鍵は api_key などを除いた URL なので、呼び手の生の URL を含む diagnose_url は保存せず、要求ごとに作る。
// 保存する本文は正規化した URL で読む（呼び手の長い URL が他の呼び手の一覧を削らない）。
// spending_halted: true は読み取り失敗でも出る安全側の値なので再利用しない（復旧後に停止中と答え続けない）。
// ============================================================
import { unstable_cache } from "next/cache";
import { diagnoseUrlFor } from "@/lib/api/diagnose-url";
import { canonicalUrl } from "@/lib/ids/canonical";
import { classifyQuery } from "@/lib/resolve/classify";
import type { CheckSellerOutput } from "@/lib/mcp/schemas";
import { checkSeller, type CheckSellerDeps } from "@/lib/mcp/tools";
import { isNoDataCacheError } from "@/lib/observatory/state-reads";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const CHECK_SELLER_CACHE_SECONDS = 60;

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

type CacheFn = typeof unstable_cache;

export type GetCheckSellerCached = (
  deps: CheckSellerDeps,
  input: { url: string; method?: string },
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

export function makeGetCheckSellerCached(cache: CacheFn): GetCheckSellerCached {
  return async (deps, input) => {
    const parts = checkSellerCacheKeyParts(input.url, input.method);
    // 正規化で伸びて照会の上限を超える URL は、正規化した形では引けないのでキャッシュを通さない。
    if (parts === null || classifyQuery(parts[0]).kind !== "url") {
      return finishFreshRead(deps, await readCheckSellerFresh(deps, input));
    }

    const [urlKey, methodKey] = parts;
    const read = cache(
      async (): Promise<CheckSellerCachedPayload> => {
        // 読み始めの時刻で数える。読み終わりで数えると、読み取りにかかった分だけ 60 秒を超える。
        const cacheReadAt = new Date().toISOString();
        const fresh = await readCheckSellerFresh(deps, { ...input, url: urlKey });
        return {
          out: checkSellerForStore(fresh.out),
          cacheReadAt: fresh.out.spending_halted === true ? "" : cacheReadAt,
          usageNetwork: fresh.usageNetwork,
        };
      },
      ["check-seller:v2", urlKey, methodKey],
      { revalidate: CHECK_SELLER_CACHE_SECONDS, tags: ["check-seller"] },
    );

    try {
      const cached = await read();
      if (isCheckSellerCachedReadFresh(cached.cacheReadAt)) {
        if (cached.usageNetwork) deps.captureUsageNetwork?.(cached.usageNetwork);
        return checkSellerForCaller(stripCheckSellerCachedPayload(cached), input.url);
      }
      return finishFreshRead(deps, await readCheckSellerFresh(deps, input));
    } catch (error) {
      if (isNoDataCacheError(error)) return finishFreshRead(deps, await readCheckSellerFresh(deps, input));
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