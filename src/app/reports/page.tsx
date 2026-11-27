import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listFrozenMonthlyLedger } from "@/lib/observatory/monthly-freeze";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Monthly ledger freezes",
  description:
    "An index of UTC months vet402 has frozen in the purchase ledger. Figures and hashes come from the stored freeze when one exists.",
  path: "/reports",
  noindex: true,
});

export default async function ReportsIndexPage() {
  const db = getDb();
  let months: { month: string; rowCount: number; contentSha256: string }[] | null = null;
  if (db) {
    try {
      const frozen = await listFrozenMonthlyLedger(db);
      months = frozen.map((r) => ({
        month: r.month,
        rowCount: r.summary.rowCount,
        contentSha256: r.contentSha256,
      }));
    } catch {
      months = null;
    }
  }

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <h1 className="doc-title">Monthly ledger freezes</h1>
        <p className="doc-p">
          vet402 stores one frozen purchase-ledger snapshot per closed UTC month. Each snapshot keeps the CSV body and a
          SHA-256 over that body (same columns as the default export; rows sorted by{" "}
          <code>attempted_at</code> as a second-precision ISO string, then <code>purchase_id</code>).
        </p>

        {months === null ? <p className="doc-p">The monthly freeze store could not be read.</p> : null}

        {months !== null && months.length === 0 ? (
          <p className="doc-p">No frozen months are stored yet.</p>
        ) : null}

        {months !== null && months.length > 0 ? (
          <ul className="doc-p list-disc pl-6">
            {months.map((m) => (
              <li key={m.month}>
                <Link href={`/reports/${m.month}`} className="underline">
                  {m.month}
                </Link>{" "}
                — {m.rowCount.toLocaleString("en-US")} rows,{" "}
                <code>{m.contentSha256.slice(0, 12)}…</code>
              </li>
            ))}
          </ul>
        ) : null}
      </article>
    </main>
  );
}