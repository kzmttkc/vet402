import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "@/lib/seo";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/cached-reads";
import { markQueued, type SellerDetail } from "@/lib/sellers/board";
import { getSellerBoardCached, getSellerDetailCached } from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import { SellerDetailView, SellersNotice } from "@/components/site/sellers/SellersViews";

/**
 * /sellers/[host] — one seller's Base listings, each with its latest purchase, what vet402 saw,
 * what to fix and whose side the failure was on (2026-09-28).
 *
 * A host that is not on the cached board is a 404 before any per-host query runs, so random
 * hosts cost no database read. The per-host read is cached per host (cached.ts).
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ host: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  return pageMetadata({
    title: `${host} — x402 purchase results on Base`,
    description: `What vet402 bought from ${host} on Base, what it saw, what to fix, and whether each failure was on the seller's side or vet402's.`,
    path: `/sellers/${host}`,
  });
}

export default async function SellerPage({ params, searchParams }: Props) {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  let detail: SellerDetail | null = null;
  try {
    const board = await getSellerBoardCached();
    if (!board.sellers.some((s) => s.host === host)) notFound();
    const fromBoard = board.sellers.find((s) => s.host === host);
    const read = await getSellerDetailCached(host);
    detail = read ? markQueued(read, fromBoard) : null;
  } catch (error) {
    // notFound() は例外で抜けるので、そのまま投げ直す（読み取りの失敗とだけ区別する）。
    if (error && typeof error === "object" && "digest" in error) throw error;
    return (
      <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
        <SellersNotice title={host}>Reading the ledger failed. Please reload in a minute.</SellersNotice>
      </main>
    );
  }
  if (!detail) notFound();
  const { page: rawPage } = await searchParams;
  const page = Math.max(1, Math.trunc(Number(rawPage ?? "1")) || 1);
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <SellerDetailView detail={detail} page={page} now={Date.parse(detail.fetchedAt)} revalidateSec={PUBLIC_READ_REVALIDATE} />
    </main>
  );
}
