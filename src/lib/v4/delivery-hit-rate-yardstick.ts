import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DELIVERY_HIT_RATE_YARDSTICK_PATH = "data/v4/delivery-hit-rate-yardstick.json";

export type MinSampleChangelogEntry = {
  changedAt: string;
  previous: number;
  next: number;
  note?: string;
};

export type DeliveryHitRateYardstick = {
  schema: string;
  fixedAt: string;
  repurchaseResultsReadNotBefore: string;
  minSample: number;
  minSampleChangelog: MinSampleChangelogEntry[];
  timeSplit: {
    trainEndUtcDate: string;
    evalStartUtcDate: string;
    note?: string;
  };
  instrumentation?: {
    evalRowCountLowerBoundConfirmOnly?: number;
    note?: string;
  };
};

const ROOT = join(process.cwd());

export function loadDeliveryHitRateYardstick(): DeliveryHitRateYardstick {
  const raw = readFileSync(join(ROOT, DELIVERY_HIT_RATE_YARDSTICK_PATH), "utf8");
  return JSON.parse(raw) as DeliveryHitRateYardstick;
}

export function validateYardstickAgainstRepurchaseBoundary(doc: DeliveryHitRateYardstick): void {
  const fixed = new Date(doc.fixedAt).getTime();
  const notBefore = new Date(doc.repurchaseResultsReadNotBefore).getTime();
  if (!(fixed < notBefore)) {
    throw new Error("yardstick fixedAt must be before repurchaseResultsReadNotBefore");
  }
  if (doc.timeSplit.evalStartUtcDate <= doc.timeSplit.trainEndUtcDate) {
    throw new Error("evalStartUtcDate must be after trainEndUtcDate");
  }
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
