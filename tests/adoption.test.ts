// ============================================================
// vet402 — the state API's `adoption` (2026-11-08).
//
// Pins that only groups outside vet402 the monthly usage table already
// publishes with a count reach the state API (no self/related, no "<3",
// no unclassified), that the month picked is the newest publishable one,
// that the state API never freezes a month, and that a failed read leaves
// the field out instead of failing the aggregate read.
// No DB, no network.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isoFromReadAt, outsideCalls } from "@/lib/observatory/adoption";
import { latestPublishableMonth } from "@/lib/api/decision-usage";

test("only outside groups with a published count", () => {
  const rows = outsideCalls({
    chain: "eip155:42220",
    month: "2026-10",
    relations: [
      { owner_relation: "self", owners: 1, calls: 900 },
      { owner_relation: "related", owners: 4, calls: 50 },
      { owner_relation: "external", owners: 5, calls: 120 },
      { owner_relation: "prezenti_grantee", owners: "<3" },
      { owner_relation: null, owners: 7 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0], source: undefined },
    { chain: "eip155:42220", month: "2026-10", ownerRelation: "external", owners: 5, calls: 120, source: undefined },
  );
  assert.match(rows[0]!.source, /\/api\/v1\/usage\/monthly\?chain=eip155%3A42220&month=2026-10$/);
});

test("newest publishable month: previous month from the 3rd, else the one before", () => {
  assert.equal(latestPublishableMonth(new Date("2026-11-08T00:00:00Z")), "2026-10");
  assert.equal(latestPublishableMonth(new Date("2026-11-02T23:59:59Z")), "2026-09");
  assert.equal(latestPublishableMonth(new Date("2027-01-03T00:00:00Z")), "2026-12");
  assert.equal(latestPublishableMonth(new Date("2027-01-02T00:00:00Z")), "2026-11");
  assert.equal(latestPublishableMonth(new Date("2027-02-01T00:00:00Z")), "2026-12");
});

test("npm read time becomes ISO 8601 in JSON", () => {
  assert.equal(isoFromReadAt("2026-11-07 12:05 UTC"), "2026-11-07T12:05:00Z");
});

test("the state API reads published months only and tolerates a failed adoption read", () => {
  const src = readFileSync("src/lib/observatory/adoption.ts", "utf8");
  assert.match(src, /readPublishedMonthlyDecisionUsage/);
  assert.doesNotMatch(src, /loadMonthlyDecisionUsage/);
  const route = readFileSync("src/app/api/v1/observatory/state/route.ts", "utf8");
  assert.match(route, /readAdoption\(\),/);
  assert.match(route, /ADOPTION_BUDGET_MS = 1_500/);
  assert.match(route, /^\s+adoption,$/m);
  assert.match(readFileSync("docs/openapi.yaml", "utf8"), /\n {18}adoption:\n/);
});
