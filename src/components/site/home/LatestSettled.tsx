import { TableScroll } from "@/components/site/TableScroll";
import { deliveredLine, type HomeReceipt } from "@/lib/observatory/home-example";

/** Five newest settled rows from the same one-day window as the receipt. */
export function LatestSettled({ rows }: { rows: readonly HomeReceipt[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="latest-settled" className="mt-16">
      <h2 id="latest-settled" className="sub-head mt-0">
        Latest settled purchases
      </h2>
      <TableScroll label="Latest settled purchases">
        <table className="fact-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Host</th>
              <th scope="col">Chain</th>
              <th scope="col" className="num">
                HTTP
              </th>
              <th scope="col">Delivered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const delivered = deliveredLine(row);
              return (
                <tr key={row.purchaseId}>
                  <td className="whitespace-nowrap tabular-nums">
                    <time dateTime={row.attemptedAt}>
                      {row.date} {row.time.slice(0, 5)} UTC
                    </time>
                  </td>
                  <td className="[overflow-wrap:anywhere]">{row.host}</td>
                  <td>{row.chain}</td>
                  <td className="num">{row.httpStatus ?? "none"}</td>
                  <td className={delivered.strong ? "font-[family-name:var(--font-display)] font-semibold" : undefined}>{delivered.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </section>
  );
}
