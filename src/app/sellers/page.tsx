import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { pageMetadata } from "@/lib/seo";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/cached-reads";
import { searchSellers, type SellerBoard } from "@/lib/sellers/board";
import { getSellerBoardCached } from "@/lib/sellers/cached";
import { SellersIndexView, SellersNotice, sellerPath } from "@/components/site/sellers/SellersViews";

/**
 * /sellers — a Base x402 seller finds its own purchase results by domain (2026-09-28).
 *
 * Read-only: the board comes from src/lib/sellers/cached.ts (Data Cache, PUBLIC_READ_REVALIDATE),
 * and the page prints the time the database was read. Search runs over the cached list, so a
 * search costs no query. Counts are never written into the page; they come from the ledger.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Sellers on Base — find your purchase results",
  description:
    "x402 sellers on Base: look up your domain to see what vet402 bought from you, what it saw, what to fix, and whether a failure was on your side or vet402's.",
  path: "/sellers",
});

export default async function SellersPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  const params = await searchParams;
  let board: SellerBoard | null = null;
  try {
    board = await getSellerBoardCached();
  } catch {
    board = null;
  }
  if (!board) {
    return (
      <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
        <SellersNotice title="Sellers on Base">Reading the ledger failed. Please reload in a minute.</SellersNotice>
      </main>
    );
  }
  const q = typeof params.q === "string" ? params.q.slice(0, 300) : "";
  const search = q.trim() ? searchSellers(board.sellers, q) : null;
  if (search?.exact && search.matches.length === 0) redirect(sellerPath(search.exact.host));
  const page = Math.max(1, Math.trunc(Number(params.page ?? "1")) || 1);
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <SellersIndexView board={board} page={page} q={q} search={search} revalidateSec={PUBLIC_READ_REVALIDATE} />
    </main>
  );
}
