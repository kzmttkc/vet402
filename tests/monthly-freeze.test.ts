// F5: monthly ledger freeze hash determinism and anchor payload compatibility.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import {
  MONTHLY_FREEZE_ANCHOR_FROM_DAY,
  buildAnchorPayloadWithMonthlyLines,
  buildMonthlyFreezeSummary,
  hashMonthlyLedgerExportBody,
  monthlyFreezePublicationError,
  readMonthlyFreezePublic,
} from "@/lib/observatory/monthly-freeze";
import { dayRootHash } from "@/lib/observatory/ledger-day-verify";

const sampleRows = [
  {
    attempted_at: "2026-11-02T10:00:00Z",
    resource_key: "b.example/api",
    network: "eip155:8453",
    status: "settled",
    amount_units: "5000",
    spent_units: "5000",
    tx_hash: "0xbb",
    http_status_paid: 200,
    latency_ms: 120,
    l2_schema: "pass",
    held_reason: "",
    request_body: "empty",
    request_body_sha256: "",
    settlement_source: "vet402_index",
    request_query: "empty",
    request_query_sha256: "",
    confirmed_units: "5000",
    purchase_id: "00000000-0000-4000-8000-000000000002",
    l2_reading: "pass",
    response_sha256: "",
    response_bytes: "0",
  },
  {
    attempted_at: "2026-11-01T12:00:00Z",
    resource_key: "a.example/api",
    network: "eip155:8453",
    status: "settled",
    amount_units: "1000",
    spent_units: "1000",
    tx_hash: "0xaa",
    http_status_paid: 200,
    latency_ms: 80,
    l2_schema: "pass",
    held_reason: "",
    request_body: "none",
    request_body_sha256: "",
    settlement_source: "seller_claim",
    request_query: "",
    request_query_sha256: "",
    confirmed_units: "1000",
    purchase_id: "00000000-0000-4000-8000-000000000001",
    l2_reading: "pass",
    response_sha256: "abc",
    response_bytes: "12",
  },
] as const;

test("hash is deterministic for the same rows", () => {
  const a = hashMonthlyLedgerExportBody(sampleRows);
  const b = hashMonthlyLedgerExportBody(sampleRows);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("hash is unchanged when input row order is shuffled", () => {
  const sorted = hashMonthlyLedgerExportBody(sampleRows);
  const shuffled = hashMonthlyLedgerExportBody([sampleRows[1], sampleRows[0]]);
  assert.equal(sorted, shuffled);
});

test("summary JSON carries row count and period", () => {
  const summary = buildMonthlyFreezeSummary("2026-11", sampleRows, EXPORT_CSV_COLUMNS, new Date("2026-12-01T00:05:00.000Z"));
  assert.equal(summary.month, "2026-11");
  assert.equal(summary.rowCount, 2);
  assert.equal(summary.periodStart, "2026-11-01");
  assert.equal(summary.periodEndExclusive, "2026-12-01");
  assert.equal(summary.contentSha256, hashMonthlyLedgerExportBody(sampleRows));
});

test("November 2026 stays not_frozen_yet until 2026-12-01 UTC", () => {
  assert.equal(monthlyFreezePublicationError("2026-11", new Date("2026-11-30T23:59:59.000Z")), "not_frozen_yet");
  assert.equal(monthlyFreezePublicationError("2026-11", new Date("2026-12-01T00:00:00.000Z")), null);
  assert.equal(monthlyFreezePublicationError("2026-12", new Date("2026-11-27T00:00:00.000Z")), "month_not_closed");
});

test("anchor payload leaves pre-cutoff days unchanged", () => {
  const ledger = JSON.stringify({ v: 1, day: "2026-11-30", rows: [] });
  const frozen = [{ month: "2026-11", contentSha256: "a".repeat(64) }];
  assert.equal(buildAnchorPayloadWithMonthlyLines(ledger, "2026-11-30", frozen), ledger);
  assert.equal(MONTHLY_FREEZE_ANCHOR_FROM_DAY, "2026-12-01");
});

test("anchor payload appends one monthly line from 2026-12-01 when frozen", () => {
  const ledger = JSON.stringify({ v: 1, day: "2026-12-01", rows: [] });
  const hash = "b".repeat(64);
  const out = buildAnchorPayloadWithMonthlyLines(ledger, "2026-12-01", [{ month: "2026-11", contentSha256: hash }]);
  assert.equal(out, `${ledger}\nmonthly-freeze:v1:2026-11:${hash}`);
});

test("not_frozen_yet before a row exists and during November for 2026-11", async () => {
  const fakeDb = { execute: async () => [] } as unknown as Parameters<typeof readMonthlyFreezePublic>[0];
  const oct = await readMonthlyFreezePublic(fakeDb, "2026-10", new Date("2026-11-15T00:00:00.000Z"));
  assert.equal(oct.status, "not_frozen_yet");
  const nov = await readMonthlyFreezePublic(fakeDb, "2026-11", new Date("2026-11-27T00:00:00.000Z"));
  assert.equal(nov.status, "not_frozen_yet");
});

test("past day roots without monthly lines match the old hash rule", () => {
  const ledgerPayload = JSON.stringify({ v: 1, day: "2026-08-15", rows: [{ id: "1" }] });
  const prev = "a".repeat(64);
  const without = dayRootHash(prev, ledgerPayload);
  const withMonthly = dayRootHash(prev, buildAnchorPayloadWithMonthlyLines(ledgerPayload, "2026-08-15", [{ month: "2026-11", contentSha256: "c".repeat(64) }]));
  assert.equal(without, withMonthly);
  const direct = createHash("sha256").update(prev).update("\n").update(ledgerPayload).digest("hex");
  assert.equal(without, direct);
});