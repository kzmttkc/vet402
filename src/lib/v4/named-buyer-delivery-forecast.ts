import { assertPublicEnglishSurface } from "./public-english";
import {
  F4_TRAINING_SNAPSHOT_SOURCE,
  loadNamedBuyerTrainingRowsUpToSnapshot,
} from "./f4-training-snapshot";

/** Published scope line for F4 v1 (V4: 名乗る買い手の場合). */
export const NAMED_BUYER_SCOPE_PHRASE_JA = "名乗る買い手の場合";
export const NAMED_BUYER_SCOPE_PHRASE_EN = "For a buyer that identifies itself";

export type NamedBuyerTrainingRow = {
  attemptedAt: string;
  resourceKey: string;
  delivered: boolean;
};

export type NamedBuyerDeliveryForecast = {
  schema: "vet402-named-buyer-delivery-forecast/v1";
  trainingSnapshotSource: typeof F4_TRAINING_SNAPSHOT_SOURCE;
  snapshotDate: string;
  resourceKey: string;
  text: string;
  trainCount: number;
  trainDelivered: number;
  deliveryRate: number | null;
};

function utcDateOf(iso: string): string {
  return iso.slice(0, 10);
}

export function trainingRowsOnOrBeforeSnapshot(
  rows: NamedBuyerTrainingRow[],
  snapshotDate: string,
): NamedBuyerTrainingRow[] {
  return rows.filter((r) => utcDateOf(r.attemptedAt) <= snapshotDate);
}

export function assertTrainingRowsOnOrBeforeSnapshot(
  rows: NamedBuyerTrainingRow[],
  snapshotDate: string,
): void {
  for (const row of rows) {
    if (utcDateOf(row.attemptedAt) > snapshotDate) {
      throw new Error(`training row attempted after snapshot: ${row.attemptedAt}`);
    }
  }
}

export function buildNamedBuyerDeliveryForecast(input: {
  snapshotDate: string;
  resourceKey: string;
  trainingRows: NamedBuyerTrainingRow[];
}): NamedBuyerDeliveryForecast {
  assertTrainingRowsOnOrBeforeSnapshot(input.trainingRows, input.snapshotDate);
  const scoped = input.trainingRows.filter((r) => r.resourceKey === input.resourceKey);
  const trainCount = scoped.length;
  const trainDelivered = scoped.filter((r) => r.delivered).length;
  const deliveryRate = trainCount > 0 ? trainDelivered / trainCount : null;
  const ratePart =
    deliveryRate === null
      ? "No settled rows for this endpoint on or before the snapshot date."
      : `Estimated delivery rate ${(deliveryRate * 100).toFixed(1)}% from ${trainCount} settled row(s) on or before the snapshot date.`;
  const englishTail = `${NAMED_BUYER_SCOPE_PHRASE_EN}, ${ratePart} Snapshot date ${input.snapshotDate}. This is a dated forecast, not a live payer verdict.`;
  assertPublicEnglishSurface(englishTail);
  const text = `${NAMED_BUYER_SCOPE_PHRASE_JA}。${englishTail}`;
  return {
    schema: "vet402-named-buyer-delivery-forecast/v1",
    trainingSnapshotSource: F4_TRAINING_SNAPSHOT_SOURCE,
    snapshotDate: input.snapshotDate,
    resourceKey: input.resourceKey,
    text,
    trainCount,
    trainDelivered,
    deliveryRate,
  };
}

export function buildNamedBuyerDeliveryForecastFromPinnedSnapshot(
  snapshotDate: string,
  resourceKey: string,
): NamedBuyerDeliveryForecast {
  const rows = loadNamedBuyerTrainingRowsUpToSnapshot(snapshotDate);
  return buildNamedBuyerDeliveryForecast({ snapshotDate, resourceKey, trainingRows: rows });
}
