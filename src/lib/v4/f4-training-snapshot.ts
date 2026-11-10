import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isDelivered } from "@/lib/observatory/delivery";

import type { NamedBuyerTrainingRow } from "./named-buyer-delivery-forecast";

/** F4 v1 training rows are pinned to Stellar roots day snapshots (export.csv rows committed per UTC day). */
export const F4_TRAINING_SNAPSHOT_SOURCE = "stellar-roots-day" as const;

const STELLAR_ROOTS_DAYS_DIR = "contracts/stellar-roots/days";

type StellarDayFile = {
  date: string;
  rows: { row: Record<string, string> }[];
};

export function loadNamedBuyerTrainingRowsUpToSnapshot(snapshotDate: string): NamedBuyerTrainingRow[] {
  const dir = join(process.cwd(), STELLAR_ROOTS_DAYS_DIR);
  const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));
  const out: NamedBuyerTrainingRow[] = [];
  for (const file of files.sort()) {
    const day = file.slice(0, 10);
    if (day > snapshotDate) continue;
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as StellarDayFile;
    for (const entry of parsed.rows) {
      const r = entry.row;
      const httpStatus = r.http_status_paid ? Number(r.http_status_paid) : null;
      out.push({
        attemptedAt: r.attempted_at,
        resourceKey: r.resource_key,
        delivered: isDelivered({ status: r.status, httpStatusPaid: httpStatus }),
      });
    }
  }
  return out;
}
