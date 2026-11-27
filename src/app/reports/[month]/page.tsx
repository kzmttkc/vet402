import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import {
  MONTHLY_FREEZE_STATUS_NOT_CLOSED,
  MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET,
  parseMonthlyFreezeMonth,
  readMonthlyFreezePublic,
} from "@/lib/observatory/monthly-freeze";
import { pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ month: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const month = (await params).month;
  const parsed = parseMonthlyFreezeMonth(month);
  const title = parsed.ok ? `Monthly ledger freeze: ${parsed.month}` : "Monthly ledger freeze";
  return pageMetadata({
    title,
    description:
      "A frozen monthly snapshot of vet402 purchase rows, with a SHA-256 over the same columns as the public export. Figures come from the frozen summary when one exists.",
    path: parsed.ok ? `/reports/${parsed.month}` : "/reports",
    noindex: true,
  });
}

export default async function MonthlyLedgerFreezePage({ params }: Props) {
  const monthParam = (await params).month;
  const parsed = parseMonthlyFreezeMonth(monthParam);
  if (!parsed.ok) {
    return (
      <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
        <article className="sheet">
          <h1 className="doc-title">Monthly ledger freeze</h1>
          <p className="doc-p">month must be YYYY-MM from 2026 through 2100.</p>
        </article>
      </main>
    );
  }

  const db = getDb();
  let state:
    | { status: "unavailable"; month: string }
    | Awaited<ReturnType<typeof readMonthlyFreezePublic>> = { status: "unavailable", month: parsed.month };
  if (db) {
    try {
      state = await readMonthlyFreezePublic(db, parsed.month);
    } catch {
      state = { status: "unavailable", month: parsed.month };
    }
  }

  const jsonUrl = `${SITE_URL}/api/v1/reports/${parsed.month}.json`;
  const csvUrl = `${SITE_URL}/api/v1/reports/${parsed.month}.csv`;

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <h1 className="doc-title">Monthly ledger freeze: {parsed.month}</h1>
        <p className="doc-p">
          vet402 freezes one UTC month of purchase rows in the same column order as{" "}
          <a href="/api/v1/observatory/export.csv" className="underline">
            /api/v1/observatory/export.csv
          </a>
          . Rows in the hash use the same columns as that export. vet402 sorts them by <code>attempted_at</code> as a
          second-precision ISO string, then <code>purchase_id</code>. That export orders by full <code>attempted_at</code>{" "}
          full precision before <code>purchase_id</code>, so rows that share the same UTC second can appear in a different
          order than in the frozen body. Daily roots for UTC days on or after the <code>frozen_at</code> date append one{" "}
          <code>monthly-freeze:v1:</code> line with <code>contentSha256</code>.
        </p>

        {state.status === "unavailable" ? (
          <p className="doc-p">The monthly freeze store could not be read.</p>
        ) : null}

        {state.status === MONTHLY_FREEZE_STATUS_NOT_CLOSED ? (
          <p className="doc-p">That UTC month has not closed yet.</p>
        ) : null}

        {state.status === MONTHLY_FREEZE_STATUS_NOT_FROZEN_YET ? (
          <p className="doc-p">
            Not frozen yet. vet402 publishes the freeze on or after 00:00 UTC on the 1st day of the next month.
          </p>
        ) : null}

        {state.status === "frozen" ? (
          <>
            <p className="doc-p">
              Frozen at {state.summary.frozenAt}. Rows in the UTC window [{state.summary.periodStart},{" "}
              {state.summary.periodEndExclusive}).
            </p>
            <dl className="doc-p">
              <dt>Row count</dt>
              <dd>{state.summary.rowCount.toLocaleString("en-US")}</dd>
              <dt>contentSha256</dt>
              <dd>
                <code>{state.summary.contentSha256}</code>
              </dd>
            </dl>
          </>
        ) : null}

        <p className="doc-p">
          <a href={jsonUrl}>JSON summary</a>
          {state.status === "frozen" ? (
            <>
              {" "}
              · <a href={csvUrl}>frozen CSV body</a>
            </>
          ) : null}
          {" "}
          · <a href="/reports">Month index</a>
        </p>
      </article>
    </main>
  );
}