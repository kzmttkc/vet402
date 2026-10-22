// The front page purchase uses the public export's day window, not a second rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PUBLIC_EXPORT_EXCLUDED_STATUSES, formatSettledReceipt, unitsToAmount } from "@/lib/observatory/home-example";

const route = readFileSync("src/app/api/v1/observatory/export.csv/route.ts", "utf8");

test("the home receipt excludes the same statuses as export.csv", () => {
  const listed = route.match(/pu\.status NOT IN \(([^)]+)\)/);
  assert.ok(listed, "the export route names the excluded statuses");
  assert.equal(
    listed[1],
    PUBLIC_EXPORT_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(", "),
  );
  const src = readFileSync("src/lib/observatory/home-example.ts", "utf8");
  assert.ok(src.includes("make_interval(days => 1)"), "the window is one day, the same as export.csv?days=1");
  assert.ok(src.includes("ORDER BY pu.attempted_at DESC, pu.id ASC"), "ties keep the smaller purchase id");
});

test("a settled export row becomes one receipt, and a bad amount becomes none", () => {
  assert.equal(unitsToAmount("1500000"), "1.5");
  const row = {
    attempted_at: "2026-10-22T00:02:27Z",
    resource_key: "api.example.com/v1/quote",
    network: "eip155:8453",
    spent_units: "1500000",
    confirmed_units: "1500000",
    tx_hash: "0xabc123def4567890",
    http_status_paid: "200",
    l2_schema: "match",
    l2_reading: "match",
    settlement_source: "seller_claim",
    id: "11111111-2222-3333-4444-555555555555",
  };
  const receipt = formatSettledReceipt(row, { rows: 12, settled: 4, from: "2026-10-21T00:00:00Z", to: "2026-10-22T00:02:27Z" });
  assert.ok(receipt);
  assert.equal(receipt.host, "api.example.com");
  assert.equal(receipt.path, "/v1/quote");
  assert.equal(receipt.amount, "1.5");
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.chain, "Base");
  assert.equal(formatSettledReceipt({ ...row, confirmed_units: "nope", spent_units: "nope" }, { rows: 1, settled: 1, from: "", to: "" }), null);
});
