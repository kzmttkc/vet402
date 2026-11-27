import Link from "next/link";
import { getIndexableSellerHostsCached } from "@/lib/sellers/seller-index";
import { sellerPath } from "@/components/site/sellers/SellersViews";

/** Links from the home page to seller records that pass the I4 index gate (2026-11-27). */
export async function HomeIndexedSellers({ linkClassName }: { linkClassName: string }) {
  const hosts = await getIndexableSellerHostsCached().catch(() => [] as string[]);
  if (hosts.length === 0) return null;
  const shown = hosts.slice(0, 8);
  return (
    <p className={linkClassName}>
      Seller records with a delivery in the last 30 days or a signed payee claim ({hosts.length}):{" "}
      {shown.map((h, i) => (
        <span key={h}>
          {i > 0 ? ", " : ""}
          <Link href={sellerPath(h)} className="underline">
            {h}
          </Link>
        </span>
      ))}
      {hosts.length > shown.length ? (
        <>
          .{" "}
          <Link href="/sellers" className="underline">
            Find a seller on Base
          </Link>
        </>
      ) : (
        "."
      )}
    </p>
  );
}