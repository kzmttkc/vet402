// ============================================================
// vet402 が掲載（listing）を読む出どころと同期時刻の正典（2026-10-21）。
//
// なぜ在るか: 2026-10-21 に x402 の売り手（CedarProof）が、/api/v1/resolve の
// `not_found.reason = "not_in_catalog"` を受け取り、vet402 がどこから掲載を読むのか、
// どうすれば載るのかがどこにも書かれていない、とメールしてきた。答えはコードの中にしか
// 無かった（catalog-source.ts の CATALOG_URL・vercel.json の cron・mpp-directory.ts）。
//
// ここが正典:
//   - resolver の not_found.listing_sources（src/lib/resolve/lookup.ts）
//   - /faq の「Why is my endpoint not listed?」の本文（src/components/site/faq-data.ts）
// の両方がこの定数から作る。同期時刻は vercel.json の crons と
// tests/listing-sources.test.ts が一致を固定する（片方だけ変えると落ちる）。
//
// 依存は軽く保つ: faq-data.ts（LP と /faq が読む）から import されるので、DB や
// 支払いのモジュールを引かない。CATALOG_URL は catalog-source.ts（軽い）から取り、
// MPP の URL はここが持って mpp-directory.ts が読む。MPP_DIRECTORY_SOURCE は
// mpp-payer.ts（viem を引く）にあるので文字列で持ち、テストで一致を確かめる。
// Circle の URL もここが持つ。circle-discovery.ts が読む（逆にすると faq が
// 同期モジュールを引き、DB が LP に入る）。
// ============================================================
import { CATALOG_SOURCE, CATALOG_URL } from "./catalog-source";

/** Tempo の MPP directory（mpp-directory.ts の既定の取得先）。 */
export const MPP_DIRECTORY_PUBLIC_URL = "https://mpp.dev/api/services";

/** Circle の x402 discovery。x402_endpoints.source に入る値。 */
export const CIRCLE_DISCOVERY_SOURCE = "circle_discovery";

/** Circle の公開目録。limit の上限は 200（circle-discovery.ts）。 */
export const CIRCLE_DISCOVERY_URL = "https://api.circle.com/v2/x402/discovery/resources";

export type ListingSource = {
  /** x402_endpoints.source に入る値。 */
  source: string;
  name: string;
  url: string;
  protocol: "x402" | "mpp";
  /** 取り込みの cron が始まる時刻（UTC・HH:MM）。vercel.json と一致する。途中で止まった回は読めたページだけ入れる（Bazaar は次の回がその続きから読む・catalog-cursor.ts）。 */
  sync_times_utc: string[];
};

export const LISTING_SOURCES: readonly ListingSource[] = [
  {
    source: CATALOG_SOURCE,
    name: "CDP Bazaar discovery catalog",
    url: CATALOG_URL,
    protocol: "x402",
    // 約 2 時間おき（2026-10-30 設計 v5 の 3）。1 回の呼び出しは前の回の続きから読む（catalog-cursor.ts）。
    sync_times_utc: ["00:05", "02:05", "04:05", "06:05", "08:05", "10:05", "12:05", "14:05", "16:05", "18:05", "20:05", "22:05"],
  },
  {
    source: "mpp_directory",
    name: "MPP directory (Tempo)",
    url: MPP_DIRECTORY_PUBLIC_URL,
    protocol: "mpp",
    sync_times_utc: ["01:30"],
  },
  {
    source: CIRCLE_DISCOVERY_SOURCE,
    name: "Circle x402 discovery",
    url: CIRCLE_DISCOVERY_URL,
    protocol: "x402",
    // 新しい cron は足さない。既存の aux（01:30 UTC）の中で MPP の後に取る。
    sync_times_utc: ["01:30"],
  },
];

/** 取り込みの cron の経路。テストが vercel.json と突き合わせる。 */
export const LISTING_SYNC_CRON_PATHS: Record<string, string> = {
  cdp_bazaar: "/api/cron/catalog-sync",
  mpp_directory: "/api/cron/catalog-sync-aux",
  circle_discovery: "/api/cron/catalog-sync-aux",
};

/** /faq の節の id。resolver の documentation はここを指す。 */
export const NOT_LISTED_FAQ_ID = "not-listed";
export const NOT_LISTED_DOC_URL = `https://vet402.com/faq#${NOT_LISTED_FAQ_ID}`;

/** CDP の「Get discovered」（Bazaar に載る条件の一次資料）。 */
export const CDP_GET_DISCOVERED_URL = "https://docs.cdp.coinbase.com/x402/seller/get-discovered";

export function listingSource(source: string): ListingSource {
  const found = LISTING_SOURCES.find((s) => s.source === source);
  if (!found) throw new Error(`unknown listing source: ${source}`);
  return found;
}

/** ["01:00", "13:00"] → "01:00 and 13:00 UTC" */
export function syncTimesText(times: readonly string[]): string {
  const list = times.length <= 1 ? times.join("") : `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
  return `${list} UTC`;
}
