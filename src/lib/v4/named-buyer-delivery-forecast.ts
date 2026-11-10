import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertPublicEnglishSurface } from "./public-english";

/** Published scope line for F4 v1 (V4: 名乗る買い手の場合). */
export const NAMED_BUYER_SCOPE_PHRASE = "For a buyer that identifies itself";

export type NamedBuyerTrainingRow = {
  attemptedAt: string;
  resourceKey: string;
  delivered: boolean;
};

export type NamedBuyerDeliveryForecast = {
  schema: "vet402-named-buyer-delivery-forecast/v1";
  snapshotDate: string;
  resourceKey: string;
  text: string;
  trainCount: number;
  trainDelivered: number;
  deliveryRate: number | null;
};

const FIXTURE_PATH = "data/v4/f4-named-buyer-training-fixture.json";

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
  const text = `${NAMED_BUYER_SCOPE_PHRASE}, ${ratePart} Snapshot date ${input.snapshotDate}. This is a dated forecast, not a live payer verdict.`;
  assertPublicEnglishSurface(text);
  return {
    schema: "vet402-named-buyer-delivery-forecast/v1",
    snapshotDate: input.snapshotDate,
    resourceKey: input.resourceKey,
    text,
    trainCount,
    trainDelivered,
    deliveryRate,
  };
}

export function loadF4TrainingFixture(): { snapshotDate: string; rows: NamedBuyerTrainingRow[] } {
  const raw = readFileSync(join(process.cwd(), FIXTURE_PATH), "utf8");
  return JSON.parse(raw) as { snapshotDate: string; rows: NamedBuyerTrainingRow[] };
}

export function buildNamedBuyerDeliveryForecastFromFixture(
  snapshotDate: string,
  resourceKey: string,
): NamedBuyerDeliveryForecast {
  const fixture = loadF4TrainingFixture();
  const rows = trainingRowsOnOrBeforeSnapshot(fixture.rows, snapshotDate);
  return buildNamedBuyerDeliveryForecast({ snapshotDate, resourceKey, trainingRows: rows });
}
