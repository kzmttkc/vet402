import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import type { SellerBoard } from "@/lib/sellers/board";
import { getSellerBoardCached } from "@/lib/sellers/cached";
import { FixFirstView, SellersNotice } from "@/components/site/sellers/SellersViews";
import TrackView from "@/components/site/TrackView";

/**
 * /sellers/fix-first — the Base listings whose latest purchase did not deliver, grouped by kind of
 * failure (src/lib/sellers/fix-modes.ts), with one fix per group and whose side it is on.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "What to fix first — x402 sellers on Base",
  description:
    "The x402 listings on Base that vet402 could not buy, grouped by what went wrong, with one fix per group and whether it is the seller's side or vet402's.",
  path: "/sellers/fix-first",
  // 2026-09-29 敵対的監査: 帰属の見直しが済むまで noindex。
  noindex: true,
});

export default async function FixFirstPage() {
  let board: SellerBoard | null = null;
  try {
    board = await getSellerBoardCached();
  } catch {
    board = null;
  }
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="fix_first_open" />
      {board ? (
        <FixFirstView board={board} revalidateSec={PUBLIC_READ_REVALIDATE} />
      ) : (
        <SellersNotice title="What to fix first">Reading the ledger failed. Please reload in a minute.</SellersNotice>
      )}
    </main>
  );
}
