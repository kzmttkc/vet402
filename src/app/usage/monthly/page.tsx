import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import {
  loadMonthlyDecisionUsage,
  monthlyUsageErrorMessage,
  parseMonthlyUsageQuery,
  USAGE_MONTHLY_EMPTY_MESSAGE,
  USAGE_MONTHLY_UNAVAILABLE_MESSAGE,
  type MonthlyDecisionUsage,
} from "@/lib/api/decision-usage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Decision call counts",
  description:
    "Counts of decision API answers for one chain and one UTC month. Figures come from the usage tables. A key appears as a number such as key-1. The page leaves out the key, the email address, and the name.",
  path: "/usage/monthly",
});

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function CountTable({
  label,
  headers,
  rows,
}: {
  label: string;
  headers: [string, string, string] | [string, string];
  rows: string[][];
}) {
  return (
    <div className="table-scroll" role="region" tabIndex={0} aria-label={label}>
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length}>None for this chain and month.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.join("\u0000")}>
                {row.map((cell, index) => (
                  <td key={`${index}-${cell}`}>{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Figures({ data }: { data: MonthlyDecisionUsage }) {
  const empty = data.keyed.length === 0 && data.keyless.length === 0;
  return (
    <>
      {empty ? <p>{USAGE_MONTHLY_EMPTY_MESSAGE}</p> : null}
      <p>
        External relation calls: {data.external_calls}
      </p>
      <h2>Keyed calls</h2>
      <CountTable
        label="Keyed decision calls"
        headers={["Label", "Relation", "Calls"]}
        rows={data.keyed.map((row) => [row.label, row.owner_relation ?? "unclassified", String(row.calls)])}
      />
      <h2>Keyless calls</h2>
      <CountTable
        label="Keyless decision calls"
        headers={["Client", "Calls"]}
        rows={data.keyless.map((row) => [row.client, String(row.calls)])}
      />
      <p>
        <a href={`/api/v1/usage/monthly?chain=${encodeURIComponent(data.chain)}&month=${encodeURIComponent(data.month)}`}>
          JSON for this chain and month
        </a>
      </p>
    </>
  );
}

export default async function UsageMonthlyPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string | string[]; month?: string | string[] }>;
}) {
  const sp = await searchParams;
  const chainRaw = one(sp.chain);
  const monthRaw = one(sp.month);
  const submitted = sp.chain !== undefined || sp.month !== undefined;
  const parsed = submitted ? parseMonthlyUsageQuery(chainRaw, monthRaw) : null;
  let data: MonthlyDecisionUsage | null = null;
  let failure: string | null = null;
  if (parsed?.ok) {
    try {
      data = await loadMonthlyDecisionUsage(parsed);
    } catch {
      failure = USAGE_MONTHLY_UNAVAILABLE_MESSAGE;
    }
  }

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <h1 className="doc-title mt-8">Decision call counts</h1>
        <p className="doc-p">
          This page lists decision API answers for the chain and UTC month in the query. Keyed calls use a stable number.
          Keyless calls use the caller class stored with the count. Relation is a label an operator sets by hand.
        </p>
        <form method="get" action="/usage/monthly" className="doc-p">
          <label>
            Chain <input name="chain" defaultValue={chainRaw} />
          </label>
          <label>
            Month <input name="month" defaultValue={monthRaw} placeholder="YYYY-MM" />
          </label>
          <button type="submit">Show counts</button>
        </form>
        {!submitted ? <p className="doc-p">Choose a chain and a UTC month.</p> : null}
        {parsed && !parsed.ok ? <p className="doc-p">{monthlyUsageErrorMessage(parsed.error)}</p> : null}
        {failure ? <p className="doc-p">{failure}</p> : null}
        {data ? <Figures data={data} /> : null}
      </article>
    </main>
  );
}
