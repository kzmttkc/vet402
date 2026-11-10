// 3.13 F4: 字面「名乗る買い手の場合」— f4-training-snapshot 等に依存しない（6f02a920 でも実行可能）
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildNamedBuyerDeliveryForecast,
  trainingRowsOnOrBeforeSnapshot,
} from "@/lib/v4/named-buyer-delivery-forecast";

const F4_V1_JA_SCOPE_LITERAL = "名乗る買い手の場合";

test("3.13-F4: 予測文に字面「名乗る買い手の場合」がある", () => {
  const rows = trainingRowsOnOrBeforeSnapshot(
    [{ attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true }],
    "2026-11-09",
  );
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/a",
    trainingRows: rows,
  });
  assert.ok(
    out.text.includes(F4_V1_JA_SCOPE_LITERAL),
    "F4 v1 forecast must include the Japanese scope phrase literal",
  );
});
