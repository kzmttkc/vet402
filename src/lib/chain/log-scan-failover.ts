import { isRangeTooWideError, isRateLimitError } from "./chunked-logs";
import { DeadlineExceededError } from "@/lib/util/deadline";
import { logServerInfoSafe } from "@/lib/util/log-safe";

/**
 * eth_getLogs の読み先を複数持ち、答えない読み先を飛ばす（2026-10-13）。
 *
 * WHY THIS EXISTS. 2026-10-08 14:00〜20:00 UTC の間に、Base の公開 RPC
 * （本番の indexer の読み先）が eth_getLogs だけを断り始めた:
 * HTTP 429・`{"code":-32011,"message":"request limit reached"}`。範囲を 1 ブロックに
 * しても、6 秒空けても、1.5 秒おきに 20 回打っても同じ答え（10/13 実測。同じ読み先の
 * eth_blockNumber・eth_getCode・eth_getBlockReceipts は 200）。範囲を縮めても待っても
 * 直らない断り方なので、chunked-logs の bisect も rate-limit の再試行も効かず、
 * index-feedback・index-owners・index-settlements（Base）の checkpoint が 5 日間
 * 1 ブロックも進まなかった。読み先が 1 つしか無かったことが穴である。
 *
 * ここがやること: 読み先を順に試し、「この読み先はいま getLogs に答えない」種類の
 * 失敗なら次へ回す。答えなかった読み先は COOLDOWN_MS の間だけ後回しにする
 * （毎回の無駄な 1 往復を払わないため。期限が切れたらまた先頭で試すので、
 * 元の読み先が戻れば自動で元に戻る）。
 *
 * ここがやらないこと:
 *  - 範囲が広すぎる、という答えは次へ回さない。それは読み先の不調ではなく
 *    こちらの聞き方の問題で、fetchRange が範囲を割って同じ読み先に聞き直す。
 *  - 期限切れ（DeadlineExceededError）も回さない。呼び手の予算の話である。
 *  - 結果を混ぜない。1 つの範囲の答えは、必ず 1 つの読み先の答えそのまま。
 */

/** 答えなかった読み先を後回しにする時間。 */
export const LOG_SCAN_ENDPOINT_COOLDOWN_MS = 5 * 60 * 1000;

export type LogScanEndpoint<A, R> = {
  /** cooldown の鍵。URL そのもの（ログには出さない）。 */
  key: string;
  /** ログに出す名前。URL は鍵を含みうるので、順番だけを名乗る（primary / fallback-1 …）。 */
  label: string;
  getLogs: (args: A) => Promise<R>;
};

const downUntil = new Map<string, number>();

/** TEST-ONLY: 後回しの記録を消す。 */
export function __resetLogScanFailoverForTests(): void {
  downUntil.clear();
}

type Disposition = "rethrow" | "next" | "next_and_cooldown";

function classify(error: unknown): Disposition {
  if (error instanceof DeadlineExceededError) return "rethrow";
  // 一時的な混雑は次の読み先を試すが、後回しにはしない（すぐ戻る種類の失敗で
  // 5 分外すと、残りの読み先に負荷が寄る）。
  if (isRateLimitError(error)) return "next";
  if (isRangeTooWideError(error)) return "rethrow";
  return "next_and_cooldown";
}

/**
 * 読み先を順に試す。全部が失敗したら 1 つだけ投げる: rate-limit の失敗があれば
 * それ（fetchRange の backoff に乗せるため）、無ければ最初の失敗。
 */
export async function getLogsWithFailover<A, R>(
  endpoints: readonly LogScanEndpoint<A, R>[],
  args: A,
  now: () => number = Date.now,
): Promise<R> {
  if (endpoints.length === 0) throw new Error("log_scan_no_endpoint");
  if (endpoints.length === 1) return endpoints[0]!.getLogs(args);

  const t = now();
  const isDown = (e: LogScanEndpoint<A, R>) => (downUntil.get(e.key) ?? 0) > t;
  // 設定の順を保ったまま、後回し中のものを末尾へ。全部が後回し中でも必ず全員を試す。
  const order = [...endpoints.filter((e) => !isDown(e)), ...endpoints.filter(isDown)];

  let firstError: unknown;
  let rateLimitError: unknown;
  for (const endpoint of order) {
    try {
      const result = await endpoint.getLogs(args);
      downUntil.delete(endpoint.key);
      return result;
    } catch (error) {
      const disposition = classify(error);
      if (disposition === "rethrow") throw error;
      if (firstError === undefined) firstError = error;
      if (disposition === "next" && rateLimitError === undefined) rateLimitError = error;
      if (disposition === "next_and_cooldown") {
        if (!isDown(endpoint)) {
          const err = error as { code?: number; details?: string; shortMessage?: string };
          logServerInfoSafe(
            "log-scan-failover",
            `${endpoint.label} refused eth_getLogs; trying the next endpoint for ${LOG_SCAN_ENDPOINT_COOLDOWN_MS / 1000}s` +
              ` code=${err?.code} details=${JSON.stringify(err?.details ?? err?.shortMessage)?.slice(0, 160)}`,
          );
        }
        downUntil.set(endpoint.key, now() + LOG_SCAN_ENDPOINT_COOLDOWN_MS);
      }
    }
  }
  throw rateLimitError ?? firstError;
}

/**
 * getLogs の予備の読み先（Base）。`LOG_SCAN_FALLBACK_RPC_URLS`（カンマ区切り・先頭から順に試す）。
 * 未設定・空文字・`none`・`off` は「予備なし」（10/13 より前の挙動そのまま）。
 *
 * 既定の予備をコードに置かない理由: getLogs の filter には、照会された agent の ID
 * （feedback の tail 走査）と、売り手の受取アドレス（決済の索引）が入る。読み先を足すことは
 * その受け取り手を足すことで、プライバシーポリシーの委託先の一覧（/legal/privacy）と
 * 一緒に決める事柄である。コードの既定で黙って増やさない。
 * （/legal/privacy には Tenderly の公開 gateway を 2026-10-14 の改訂で載せた。別の相手を
 * 入れるときは、先に一覧へ足す。）
 *
 * `https:` だけを通す（2026-10-13 点検）。filter の中身と、URL に入る鍵を平文で流さないため。
 * `http:` は手元の試験用に localhost・127.0.0.1・[::1] だけ。
 *
 * 10/13 に実測した、鍵なしで getLogs に答える Base の読み先（値の案。採否は運用者）:
 *   https://base.gateway.tenderly.co — 1 回 1,000 ブロックまで（超えると -32602 の data に
 *     "maximum 1000 blocks"。chunked-logs がその幅を読んで割る）・1,000 ブロックで 0.35〜0.6 秒・
 *     4 並列 40 回で 2 回、8 並列 40 回で 7 回が "rate limit exceeded"（backoff で通る）。
 *     答えは、本番が 10/8 に記録した範囲（52328550-52339334 で 2 件）と、別の読み先
 *     （bloXroute）の 3 つの範囲（4 件・66 件・2 件）で一致。主 = mainnet.base.org・予備 = これ、
 *     で 10/8 からの滞留 218,107 ブロック（10,640 件）を 21.8 秒で読めた。
 *   https://base.rpc.blxrbdn.com — 10,000 ブロックまで答えるが 1 回 5〜22 秒。
 * 鍵つきの読み先（Alchemy など）を持つなら、それを先頭に書く。
 */
export function logScanFallbackRpcUrls(env: Record<string, string | undefined> = process.env): string[] {
  const trimmed = (env.LOG_SCAN_FALLBACK_RPC_URLS ?? "").trim();
  if (trimmed === "" || /^(none|off)$/i.test(trimmed)) return [];
  const out: string[] = [];
  for (const part of trimmed.split(",")) {
    const url = part.trim();
    if (!isAcceptableLogScanUrl(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 予備の読み先として受け付ける URL か。production-env.ts が同じ規則で warn を数える。 */
export function isAcceptableLogScanUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** `LOG_SCAN_FALLBACK_RPC_URLS` のうち、URL として読めずに捨てられる項目の数（値は返さない: 鍵を含みうる）。 */
export function invalidLogScanFallbackEntries(env: Record<string, string | undefined> = process.env): number {
  const trimmed = (env.LOG_SCAN_FALLBACK_RPC_URLS ?? "").trim();
  if (trimmed === "" || /^(none|off)$/i.test(trimmed)) return 0;
  return trimmed.split(",").map((part) => part.trim()).filter((part) => !isAcceptableLogScanUrl(part)).length;
}
