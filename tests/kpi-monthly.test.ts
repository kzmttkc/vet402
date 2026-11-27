import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildKpiMonthlyDocument,
  hashKpiMonthlyDocument,
  serializeKpiMonthlyDocument,
} from "@/lib/kpi/monthly-document";
import { buildX402RevenueFromRaw } from "@/lib/kpi/x402-revenue";

test("KPI monthly JSON is JCS-stable and hash repeats", () => {
  const x402 = buildX402RevenueFromRaw(
    "2026-11-01",
    "2026-12-01",
    [
      {
        txHash: "0xabc",
        blockNumber: "1",
        timeStamp: "1730419200",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x973cd8a91a771c2c04c6036888f8175d6b4f6227",
        value: "10000",
      },
    ],
    new Set(),
    "alchemy",
  );
  const doc = buildKpiMonthlyDocument({
    month: "2026-11",
    computedAt: "2026-12-01T00:00:05.000Z",
    x402,
  });
  const s1 = serializeKpiMonthlyDocument(doc);
  const h1 = hashKpiMonthlyDocument(doc);
  const doc2 = buildKpiMonthlyDocument({
    month: "2026-11",
    computedAt: "2026-12-01T00:00:05.000Z",
    x402,
  });
  const h2 = hashKpiMonthlyDocument(doc2);
  assert.equal(h1, h2);
  assert.equal(s1, serializeKpiMonthlyDocument(doc2));
  assert.match(s1, /"month":"2026-11"/);
  assert.match(s1, /"x402BaseUsdcIncludedAmountUnits":"10000"/);
});

test("x402 unreadable leaves revenue metrics null", () => {
  const x402 = buildX402RevenueFromRaw("2026-11-01", "2026-12-01", [], new Set(), "alchemy");
  const unreadable = { ...x402, readStatus: "unreadable" as const, readDetail: "test" };
  const doc = buildKpiMonthlyDocument({
    month: "2026-11",
    computedAt: "2026-12-01T00:00:00.000Z",
    x402: unreadable,
  });
  assert.equal(doc.metrics.x402BaseUsdcIncludedAmountUnits, null);
  assert.equal(doc.inputs.x402BaseUsdc.readStatus, "unreadable");
  // 除外件数も 0 ではなく null（読めなかった月を「除外 0 件」として凍結しない）
  assert.equal(doc.exclusions.x402ExcludedTransferCount, null);
  assert.equal(doc.exclusions.x402ExcludedAmountUnits, null);
  assert.equal(doc.metrics.revenueUsd, null);
});

test("coverage names the x402 receipts not read yet (Robinhood Chain USDG)", () => {
  const x402 = buildX402RevenueFromRaw("2026-11-01", "2026-12-01", [], new Set(), "public_rpc");
  const doc = buildKpiMonthlyDocument({ month: "2026-11", computedAt: "2026-12-01T00:00:00.000Z", x402 });
  assert.deepEqual(doc.coverage.x402NetworksRead, ["eip155:8453 USDC"]);
  assert.deepEqual(doc.coverage.x402NetworksNotRead, ["eip155:4663 USDG"]);
  assert.equal(doc.metrics.revenueUsd, null);
});