import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { pageMetadata } from "@/lib/seo";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { boardAsOfDay, parseSellerSideFilter, searchSellers, type SellerBoard } from "@/lib/sellers/board";
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

// 2026-09-29 第2巡: 表題に「いつの結果か」の日付（最新の試行の UTC の日付・一覧のキャッシュから）。
export async function generateMetadata(): Promise<Metadata> {
  const day = await getSellerBoardCached()
    .then((b) => boardAsOfDay(b))
    .catch(() => null);
  return pageMetadata({
    title: day ? `Sellers on Base: purchase results as of ${day}` : "Sellers on Base: purchase results",
    description:
      "x402 sellers on Base: look up your domain to see what vet402 tried to buy from you, what it saw, what to fix, and whether a failure was on your side or vet402's.",
    path: "/sellers",
    // 2026-09-29 敵対的監査: 帰属（どちら側の失敗か）の見直しが済むまで、他社名の並ぶ頁を検索に出さない。
    noindex: true,
  });
}

export default async function SellersPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string; side?: string }> }) {
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
  // 2026-09-29 第6巡: 区分の絞り込み（?side=seller|vet402|unsorted|delivered・知らない値は全部）。
  const side = parseSellerSideFilter(params.side);
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <SellersIndexView board={board} page={page} q={q} search={search} revalidateSec={PUBLIC_READ_REVALIDATE} side={side} />
    </main>
  );
}
