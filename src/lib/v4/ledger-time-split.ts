export type LedgerTimeSplitRow = {
  attemptedAt: string;
  delivered: boolean;
};

export type TimeSplitSpec = {
  trainEndUtcDate: string;
  evalStartUtcDate: string;
};

function utcDateOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Partition ledger rows for delivery hit-rate instrumentation (S1-2). */
export function partitionLedgerByTimeSplit(
  rows: LedgerTimeSplitRow[],
  split: TimeSplitSpec,
): { train: LedgerTimeSplitRow[]; eval: LedgerTimeSplitRow[] } {
  const train: LedgerTimeSplitRow[] = [];
  const evalRows: LedgerTimeSplitRow[] = [];
  for (const row of rows) {
    const d = utcDateOf(row.attemptedAt);
    if (d <= split.trainEndUtcDate) train.push(row);
    else if (d >= split.evalStartUtcDate) evalRows.push(row);
  }
  return { train, eval: evalRows };
}
