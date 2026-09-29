// ============================================================
// /sellers の頁だけが使う読み取りキャッシュ（Next の Data Cache）。
//
// 公開頁は CSP の nonce で毎回動的に描画される（cached-reads.ts の冒頭）ので、`revalidate` を頁に
// 書いても効かない。代わりに問い合わせの結果をここに載せる。窓は観測所の頁と同じ
// PUBLIC_READ_REVALIDATE 秒（1 つの値）。結果には DB を読んだ時刻（fetchedAt）が入っていて、
// 頁はその時刻を出す——キャッシュから返した値に「今」の時刻を付けない。
//
// API ルートからは使わない（tests/public-page-cache.test.ts）。
// 2026-09-29 第4巡: 返す形が変わった（ShownRow の証拠・SellerDetail の hasConfirmedSeller / sellerView）ので
// 鍵を v2 に上げた。配備の直後に古い形のキャッシュを新しい描画へ渡さない。
// 2026-09-29 第5巡: 行の事実に照合の確定時刻（verifiedAt）が増えたので v3 に。出品の判定 API の resource id を足した。
// ============================================================
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import type { SellerBoard, SellerDetail, SellerOtherChains } from "./board";
import { readPurchasedHosts, readSellerBoard, readSellerDetail, readSellerOtherChains } from "./reader";

export class SellersUnavailable extends Error {}

export const getSellerBoardCached: () => Promise<SellerBoard> = unstable_cache(
  async () => {
    const db = getDb();
    if (!db) throw new SellersUnavailable("database not configured");
    return readSellerBoard(db);
  },
  ["sellers:board:v3"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getSellerDetailCached: (host: string) => Promise<SellerDetail | null> = unstable_cache(
  async (host: string) => {
    const db = getDb();
    if (!db) throw new SellersUnavailable("database not configured");
    return readSellerDetail(db, host);
  },
  ["sellers:detail:v3"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

/** 購入行のある host の集合（Base の出品が無い売り手の頁の関門・1 本でキャッシュ）。 */
export const getPurchasedHostsCached: () => Promise<string[]> = unstable_cache(
  async () => {
    const db = getDb();
    if (!db) throw new SellersUnavailable("database not configured");
    return readPurchasedHosts(db);
  },
  ["sellers:purchased-hosts:v1"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getSellerOtherChainsCached: (host: string) => Promise<SellerOtherChains | null> = unstable_cache(
  async (host: string) => {
    const db = getDb();
    if (!db) throw new SellersUnavailable("database not configured");
    return readSellerOtherChains(db, host);
  },
  ["sellers:other-chains:v3"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

