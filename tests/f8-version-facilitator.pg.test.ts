// F8: byFacilitator totals match l1; unknown bucket always present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getObservatoryStats } from "@/lib/observatory/reader";

test("byFacilitator sums match l1 totals including unknown", async () => {
  const stats = await getObservatoryStats();
  const rows = stats.l1.byFacilitator;
  const sum = (k: "attempts" | "settled" | "delivered" | "inconclusiveSettled") =>
    rows.reduce((n, b) => n + b[k], 0);
  assert.equal(sum("attempts"), stats.l1.attempts);
  assert.equal(sum("settled"), stats.l1.settled);
  assert.equal(sum("delivered"), stats.l1.delivered);
  assert.equal(sum("inconclusiveSettled"), stats.l1.inconclusiveSettled);
  const unknown = rows.find((b) => b.facilitator === "unknown");
  assert.ok(unknown, "unknown bucket must always be present");
  assert.equal(typeof unknown!.attempts, "number");
});