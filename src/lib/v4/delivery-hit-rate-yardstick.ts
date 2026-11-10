import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DELIVERY_HIT_RATE_YARDSTICK_PATH = "data/v4/delivery-hit-rate-yardstick.json";

/** S1-3 boundary for reading repurchase results (code constant, not self-declared in yardstick JSON). */
export const REPURCHASE_RESULTS_READ_NOT_BEFORE = "2026-11-11T00:00:00.000Z";

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

export function validateFixedAtChangelog(doc: DeliveryHitRateYardstick): void {
  if (doc.fixedAt === doc.fixedAtInitial) {
    if (doc.fixedAtChangelog.length > 0) {
      const last = doc.fixedAtChangelog[doc.fixedAtChangelog.length - 1]!;
      if (last.next !== doc.fixedAt) {
        throw new Error("fixedAtChangelog last next must match current fixedAt");
      }
    }
    return;
  }
  if (doc.fixedAtChangelog.length === 0) {
    throw new Error("fixedAt changed from fixedAtInitial without a published changelog entry");
  }
  const last = doc.fixedAtChangelog[doc.fixedAtChangelog.length - 1]!;
  if (last.next !== doc.fixedAt) {
    throw new Error("fixedAtChangelog last next must match current fixedAt");
  }
}

export function validateYardstickAgainstRepurchaseBoundary(doc: DeliveryHitRateYardstick): void {
  if ("repurchaseResultsReadNotBefore" in (doc as Record<string, unknown>)) {
    throw new Error("yardstick JSON must not self-declare repurchaseResultsReadNotBefore");
  }
  if ("instrumentation" in (doc as Record<string, unknown>)) {
    throw new Error("yardstick JSON must not include V4 marketing instrumentation fields");
  }
  const fixed = new Date(doc.fixedAt).getTime();
  const committed = new Date(doc.documentFirstCommittedAt).getTime();
  const notBefore = new Date(REPURCHASE_RESULTS_READ_NOT_BEFORE).getTime();
  if (!(fixed >= committed)) {
    throw new Error("yardstick fixedAt must be on or after documentFirstCommittedAt");
  }
  if (!(fixed < notBefore)) {
    throw new Error("yardstick fixedAt must be before REPURCHASE_RESULTS_READ_NOT_BEFORE");
  }
  if (doc.timeSplit.evalStartUtcDate <= doc.timeSplit.trainEndUtcDate) {
    throw new Error("evalStartUtcDate must be after trainEndUtcDate");
  }
  validateFixedAtChangelog(doc);
  validateMinSampleChangelog(doc);
}

export function validateMinSampleChangelog(doc: DeliveryHitRateYardstick): void {
  if (doc.minSample === doc.minSampleInitial) {
    if (doc.minSampleChangelog.length > 0) {
      const last = doc.minSampleChangelog[doc.minSampleChangelog.length - 1]!;
      if (last.next !== doc.minSample) {
        throw new Error("minSampleChangelog last next must match current minSample");
      }
    }
    return;
  }
  if (doc.minSampleChangelog.length === 0) {
    throw new Error("minSample changed from minSampleInitial without a published changelog entry");
  }
  const last = doc.minSampleChangelog[doc.minSampleChangelog.length - 1]!;
  if (last.next !== doc.minSample) {
    throw new Error("minSampleChangelog last next must match current minSample");
  }
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
