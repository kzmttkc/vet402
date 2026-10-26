import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import {
  loadMonthlyDecisionUsage,
  MonthlyUsageRejected,
  monthlyPublicationError,
  monthlyUsageErrorMessage,
  parseMonthlyUsageQuery,
  PUBLIC_USAGE_CHAINS,
  USAGE_MONTHLY_EMPTY_MESSAGE,
  USAGE_MONTHLY_UNAVAILABLE_MESSAGE,
  type MonthlyDecisionUsage,
} from "@/lib/api/decision-usage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Decision call counts",
  description:
    "Counts of decision API answers made with a key, for one published chain and one closed UTC month. The figures are stored on the first read after 00:00 UTC on the 3rd day of the next month. Answers are summed by relation. A labeled relation shows the number of owners. Fewer than 3 owners shows <3 and leaves the call count out. An unclassified relation leaves the call count out. Calls made without a key are not counted per chain. The page leaves out the key, the email address, and the name.",
  path: "/usage/monthly",
  noindex: true,
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
  const empty = data.relations.length === 0;
  return (
    <>
      {empty ? <p>{USAGE_MONTHLY_EMPTY_MESSAGE}</p> : null}
      <h2>Calls by relation</h2>
      <p>
        A labeled relation with fewer than 3 owners shows &lt;3 and leaves the call count off this page. An unclassified
        relation leaves the call count off this page.
      </p>
      <CountTable
        label="Decision calls by relation"
        headers={["Relation", "Owners", "Calls"]}
        rows={data.relations.map((row) => [
          row.owner_relation ?? "unclassified",
          row.owners === "<3" ? "<3" : String(row.owners),
          row.calls === undefined ? "withheld" : String(row.calls),
        ])}
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
    const publication = monthlyPublicationError(parsed);
    if (publication) {
      failure = monthlyUsageErrorMessage(publication);
    } else {
      try {
        data = await loadMonthlyDecisionUsage(parsed);
      } catch (error) {
        failure =
          error instanceof MonthlyUsageRejected
            ? monthlyUsageErrorMessage(error.code)
            : USAGE_MONTHLY_UNAVAILABLE_MESSAGE;
      }
    }
  }

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <h1 className="doc-title mt-8">Decision call counts</h1>
        <p className="doc-p">
          This page sums decision API answers made with a key, for one published chain and one closed UTC month. The
          figures are stored on the first read after 00:00 UTC on the 3rd day of the next month, and later reads return
          that stored copy. Answers are grouped by relation. A labeled relation shows the number of owners and the
          number of calls. Fewer than 3 owners shows &lt;3 and leaves the call count off this page. An unclassified
          relation leaves the call count off this page. Calls made without a key are not counted per chain. Relation is
          a label an operator sets by hand. Published chains: {PUBLIC_USAGE_CHAINS.join(", ")}.
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
