// Write one UTC day of settled Circle Gateway rows to a records json file and print the Merkle root.
// Reads the database. Does not send a transaction and does not read a private key.
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { buildGatewayDayRecords, type GatewayDaySourceRow } from "@/lib/observatory/arc-gateway-root";

const args = process.argv.slice(2);
if (args.some((a) => a === "--send" || a === "--broadcast")) {
  console.error("refusing to send");
  process.exit(2);
}

function flag(name: string): string | null {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

const day = flag("--day");
const out = flag("--out");
if (!day || !out) {
  console.error("usage: tsx scripts/arc-gateway-records.ts --day YYYY-MM-DD --out records.json");
  process.exit(2);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error("bad_day");
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

type DayRow = {
  resource_url: string;
  method: string | null;
  http_status_paid: number | null;
  circle_gateway: unknown;
  attempted_at: string;
};

async function main(dayArg: string, outArg: string, databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const found = await sql<DayRow[]>`
      SELECT e.resource_url, e.method, pu.http_status_paid,
             pu.raw_response_meta->'circleGateway' AS circle_gateway,
             to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attempted_at
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.status = 'settled'
        AND pu.raw_response_meta->>'circleGatewayRail' = 'true'
        AND pu.attempted_at >= ${dayArg}::date
        AND pu.attempted_at < (${dayArg}::date + interval '1 day')
      ORDER BY pu.attempted_at ASC, pu.id ASC
    `;
    const rows: GatewayDaySourceRow[] = found.map((r) => ({
      attemptedAt: r.attempted_at,
      resourceUrl: r.resource_url,
      method: r.method,
      httpStatus: r.http_status_paid,
      circleGateway: typeof r.circle_gateway === "object" && r.circle_gateway !== null && !Array.isArray(r.circle_gateway)
        ? (r.circle_gateway as Record<string, unknown>)
        : null,
    }));
    const built = buildGatewayDayRecords(dayArg, rows);
    if (!built.ok) {
      console.error(built.reason);
      process.exit(2);
    }
    writeFileSync(outArg, `${JSON.stringify(built.document, null, 2)}\n`);
    console.log(`root ${built.document.root}`);
    console.log(`purchases ${built.document.purchases}`);
    console.log(`delivered ${built.document.delivered}`);
    console.log(`wrote ${outArg}`);
  } finally {
    await sql.end();
  }
}

main(day, out, url).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
