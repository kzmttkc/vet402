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
  documentFirstCommittedAt: string;
  repurchaseResultsReadNotBefore: string;
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

export function validateYardstickAgainstRepurchaseBoundary(doc: DeliveryHitRateYardstick): void {
  const fixed = new Date(doc.fixedAt).getTime();
  const committed = new Date(doc.documentFirstCommittedAt).getTime();
  const notBefore = new Date(doc.repurchaseResultsReadNotBefore).getTime();
  if (!(fixed >= committed)) {
    throw new Error("yardstick fixedAt must be on or after documentFirstCommittedAt");
  }
  if (!(fixed < notBefore)) {
    throw new Error("yardstick fixedAt must be before repurchaseResultsReadNotBefore");
  }
  if (doc.timeSplit.evalStartUtcDate <= doc.timeSplit.trainEndUtcDate) {
    throw new Error("evalStartUtcDate must be after trainEndUtcDate");
  }
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
