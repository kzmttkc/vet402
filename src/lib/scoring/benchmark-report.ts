import { MIN_SAMPLE } from "./accuracy";

// ============================================================
// Vouch — operator-benchmark report arithmetic (2026-08-06).
//
// Pure on purpose, same as accuracy.ts: these numbers land on the public
// /accuracy page under the "Operator benchmark" heading, so the arithmetic
// is unit-tested without a database.
//
// This is a DIFFERENT question from the external accuracy report. External:
// "of the verdicts customers requested, what happened afterwards?" —
// outcomes arrive later. Benchmark: "against addresses whose outcome is
// already publicly known, does the engine say the right thing?" — the truth
// predates the verdict. Mixing the two would let self-seeded rows pad the
// external sample, which is exactly the fabrication this product exists to
// reject; the split is enforced at the SQL layer (outcome-reader.ts
// partitions on source = 'operator_benchmark').
//
// Scoring rules (documented on /accuracy):
//   known-bad  + BLOCK/WARN → detected (true positive)
//   known-bad  + ALLOW      → missed  (false negative — the bad number)
//   known-good + ALLOW      → allowed (true negative)
//   known-good + WARN       → warned  (friction; reported, not a rate)
//   known-good + BLOCK      → blocked (false positive — the bad number)
// Each address counts ONCE per report using its most recent scan — weekly
// re-scans refresh the measurement, they must not multiply the sample.
// ============================================================

/** Row shape the benchmark reader produces (outcome-reader.ts). */
export interface BenchmarkRow {
  /** lowercase benchmark address (verdict_outcomes.related_wallet) */
  relatedWallet: string | null;
  /** recommendation of the seeded verdict at scan time */
  recommendation: string | null;
  /** confirmed_fraud (known-bad) | confirmed_legitimate (known-good) */
  outcomeType: string;
  detectedAt: string | Date | null;
}

export interface BenchmarkReport {
  /** distinct labeled addresses with at least one scan in the window */
  knownBad: {
    total: number;
    detected: number; // BLOCK or WARN
    blocked: number;
    warned: number;
    missed: number; // ALLOW — false negatives
    /** detected / total, null below minSample */
    detectionRate: number | null;
    /** missed / total, null below minSample — the unflattering number */
    missRate: number | null;
  };
  knownGood: {
    total: number;
    allowed: number;
    warned: number;
    blocked: number; // false positives
    /** blocked / total, null below minSample — the unflattering number */
    falsePositiveRate: number | null;
  };
  /** raw scan rows in the window (each address may have several) */
  scans: number;
  lastScanAt: string | null;
  /** Addresses scanned on the UTC day of lastScanAt. A "most recent" scan can be one address. */
  lastScanAddresses: number;
  /** Latest UTC day whose scans covered at least half of the addresses in the window. */
  lastBroadScan: { date: string; addresses: number } | null;
  minSample: number;
  methodologyVersion: 1;
}

function toTime(value: string | Date | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function computeBenchmarkReport(rows: BenchmarkRow[]): BenchmarkReport {
  // Latest scan per address. Rows with no wallet or an unknown outcome type
  // are ignored defensively — an unclassifiable row must not move a
  // published rate (same rule as accuracy.ts).
  const latest = new Map<string, BenchmarkRow>();
  let scans = 0;
  let lastScanMs = 0;
  const addressesByDay = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.relatedWallet) continue;
    if (row.outcomeType !== "confirmed_fraud" && row.outcomeType !== "confirmed_legitimate") {
      continue;
    }
    scans += 1;
    const t = toTime(row.detectedAt);
    if (t > lastScanMs) lastScanMs = t;
    const key = row.relatedWallet.toLowerCase();
    if (t > 0) {
      const day = new Date(t).toISOString().slice(0, 10);
      const seen = addressesByDay.get(day) ?? new Set<string>();
      seen.add(key);
      addressesByDay.set(day, seen);
    }
    const existing = latest.get(key);
    if (!existing || t >= toTime(existing.detectedAt)) {
      latest.set(key, row);
    }
  }

  const bad = { total: 0, detected: 0, blocked: 0, warned: 0, missed: 0 };
  const good = { total: 0, allowed: 0, warned: 0, blocked: 0 };

  for (const row of latest.values()) {
    const rec = row.recommendation?.toUpperCase();
    if (rec !== "ALLOW" && rec !== "WARN" && rec !== "BLOCK") continue;
    if (row.outcomeType === "confirmed_fraud") {
      bad.total += 1;
      if (rec === "BLOCK") {
        bad.blocked += 1;
        bad.detected += 1;
      } else if (rec === "WARN") {
        bad.warned += 1;
        bad.detected += 1;
      } else {
        bad.missed += 1;
      }
    } else {
      good.total += 1;
      if (rec === "ALLOW") good.allowed += 1;
      else if (rec === "WARN") good.warned += 1;
      else good.blocked += 1;
    }
  }

  const lastScanAddresses = lastScanMs > 0 ? (addressesByDay.get(new Date(lastScanMs).toISOString().slice(0, 10))?.size ?? 0) : 0;
  const broadDays = [...addressesByDay.entries()]
    .filter(([, seen]) => seen.size * 2 >= latest.size)
    .map(([date, seen]) => ({ date, addresses: seen.size }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const rate = (num: number, den: number): number | null =>
    den >= MIN_SAMPLE ? Math.round((num / den) * 1000) / 10 : null;

  return {
    knownBad: {
      ...bad,
      detectionRate: rate(bad.detected, bad.total),
      missRate: rate(bad.missed, bad.total),
    },
    knownGood: {
      ...good,
      falsePositiveRate: rate(good.blocked, good.total),
    },
    scans,
    lastScanAt: lastScanMs > 0 ? new Date(lastScanMs).toISOString() : null,
    lastScanAddresses,
    lastBroadScan: broadDays[0] ?? null,
    minSample: MIN_SAMPLE,
    methodologyVersion: 1,
  };
}
