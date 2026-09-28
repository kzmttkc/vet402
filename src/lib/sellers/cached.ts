// ============================================================
// /sellers の頁だけが使う読み取りキャッシュ（Next の Data Cache）。
//
// 公開頁は CSP の nonce で毎回動的に描画される（cached-reads.ts の冒頭）ので、`revalidate` を頁に
// 書いても効かない。代わりに問い合わせの結果をここに載せる。窓は観測所の頁と同じ
// PUBLIC_READ_REVALIDATE 秒（1 つの値）。結果には DB を読んだ時刻（fetchedAt）が入っていて、
// 頁はその時刻を出す——キャッシュから返した値に「今」の時刻を付けない。
//
// API ルートからは使わない（tests/public-page-cache.test.ts）。
// ============================================================
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import type { SellerBoard, SellerDetail } from "./board";
import { readSellerBoard, readSellerDetail } from "./reader";

export class SellersUnavailable extends Error {}

export const getSellerBoardCached: () => Promise<SellerBoard> = unstable_cache(
  async () => {
    const db = getDb();
    if (!db) throw new SellersUnavailable("database not configured");
    return readSellerBoard(db);
  },
  ["sellers:board:v1"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export const getSellerDetailCached: (host: string) => Promise<SellerDetail | null> = unstable_cache(
  async (host: string) => {
    const db = getDb();
    if (!db) throw new SellersUnavailable("database not configured");
    return readSellerDetail(db, host);
  },
  ["sellers:detail:v1"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);
