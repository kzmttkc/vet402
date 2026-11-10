import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DELIVERY_HIT_RATE_YARDSTICK_PATH = "data/v4/delivery-hit-rate-yardstick.json";

/*
 * There is no hard-coded "results are read after" clock here. A constant would be a boundary the
 * yardstick declares for itself. The boundary is the first commit in git history whose code reads
 * the S1-3 results, and tests/v4-313-must-1110.test.ts finds it in the history and compares it with
 * fixedAt. A deployment has no .git, so this module only checks the document's own structure.
 */

export type MinSampleChangelogEntry = {
  changedAt: string;
  previous: number;
  next: number;
  note?: string;
};

export type FixedAtChangelogEntry = {
  changedAt: string;
  previous: string;
  next: string;
  note?: string;
};

export type DeliveryHitRateYardstick = {
  schema: string;
  fixedAt: string;
  fixedAtInitial: string;
  fixedAtChangelog: FixedAtChangelogEntry[];
  documentFirstCommittedAt: string;
  minSampleInitial: number;
  minSample: number;
  minSampleRationale: string;
  minSampleChangelog: MinSampleChangelogEntry[];
  timeSplit: {
    trainEndUtcDate: string;
    evalStartUtcDate: string;
    note?: string;
  };
};

const ROOT = join(process.cwd());

export function loadDeliveryHitRateYardstick(): DeliveryHitRateYardstick {
  const raw = readFileSync(join(ROOT, DELIVERY_HIT_RATE_YARDSTICK_PATH), "utf8");
  return JSON.parse(raw) as DeliveryHitRateYardstick;
}

function assertChain<T>(
  label: string,
  initial: T,
  current: T,
  rows: { previous: T; next: T }[],
): void {
  let at = initial;
  rows.forEach((row, i) => {
    if (row.previous !== at) {
      throw new Error(`${label}Changelog[${i}].previous must equal the value before it`);
    }
    if (row.next === row.previous) {
      throw new Error(`${label}Changelog[${i}] must change the value`);
    }
    at = row.next;
  });
  if (at !== current) {
    if (rows.length === 0) {
      throw new Error(`${label} changed from ${label}Initial without a published changelog entry`);
    }
    throw new Error(`${label}Changelog last next must match current ${label}`);
  }
}

export function validateFixedAtChangelog(doc: DeliveryHitRateYardstick): void {
  assertChain("fixedAt", doc.fixedAtInitial, doc.fixedAt, doc.fixedAtChangelog);
  for (const [i, row] of doc.fixedAtChangelog.entries()) {
    if (Number.isNaN(new Date(row.changedAt).getTime()) || Number.isNaN(new Date(row.next).getTime())) {
      throw new Error(`fixedAtChangelog[${i}] must hold ISO times`);
    }
  }
}

export function validateMinSampleChangelog(doc: DeliveryHitRateYardstick): void {
  assertChain("minSample", doc.minSampleInitial, doc.minSample, doc.minSampleChangelog);
}

/** Structure of the published yardstick. Runs in the route on every read. */
export function validateDeliveryHitRateYardstick(doc: DeliveryHitRateYardstick): void {
  const raw = doc as Record<string, unknown>;
  if ("repurchaseResultsReadNotBefore" in raw) {
    throw new Error("yardstick JSON must not self-declare repurchaseResultsReadNotBefore");
  }
  if ("instrumentation" in raw) {
    throw new Error("yardstick JSON must not include V4 marketing instrumentation fields");
  }
  const fixed = new Date(doc.fixedAt).getTime();
  const committed = new Date(doc.documentFirstCommittedAt).getTime();
  if (Number.isNaN(fixed) || Number.isNaN(committed)) {
    throw new Error("yardstick fixedAt and documentFirstCommittedAt must be ISO times");
  }
  if (!(fixed >= committed)) {
    throw new Error("yardstick fixedAt must be on or after documentFirstCommittedAt");
  }
  if (!(Number.isInteger(doc.minSample) && doc.minSample > 0)) {
    throw new Error("yardstick minSample must be a positive integer");
  }
  if (doc.timeSplit.evalStartUtcDate <= doc.timeSplit.trainEndUtcDate) {
    throw new Error("evalStartUtcDate must be after trainEndUtcDate");
  }
  validateFixedAtChangelog(doc);
  validateMinSampleChangelog(doc);
}

export type PublicDeliveryHitRateYardstick = Omit<
  DeliveryHitRateYardstick,
  never
> & {
  gate2IsNotHitRate: true;
};

export function publicDeliveryHitRateYardstick(doc: DeliveryHitRateYardstick): PublicDeliveryHitRateYardstick {
  return { ...doc, gate2IsNotHitRate: true };
}

export function applyMinSampleChange(
  doc: DeliveryHitRateYardstick,
  next: number,
  changedAt: string,
  note?: string,
): DeliveryHitRateYardstick {
  if (next === doc.minSample) return doc;
  return {
    ...doc,
    minSample: next,
    minSampleChangelog: [
      ...doc.minSampleChangelog,
      { changedAt, previous: doc.minSample, next, note },
    ],
  };
}
