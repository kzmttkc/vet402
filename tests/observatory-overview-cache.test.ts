import { test } from "node:test";
import assert from "node:assert/strict";
import { overviewFromCache, overviewToCache } from "../src/lib/observatory/cached-reads";

// 2026-10-25: the cached /observatory overview goes through JSON. lastProbedAt must come back as a Date,
// and every other field must come back unchanged.
test("overview survives the JSON round trip of the cache with lastProbedAt as a Date", () => {
  const probed = new Date("2026-10-24T10:30:00.000Z");
  const row = { lastProbedAt: probed, resourceKey: "a.example/x" } as never;
  const empty = { lastProbedAt: null, resourceKey: "b.example/y" } as never;
  const overview = {
    rows: [row, empty],
    page: 1,
    pageSize: 40,
    totalEndpoints: 2,
    latestSnapshot: null,
    verdictCounts: { pass: 1, fail: 0, unverified: 1, withdrawn: 0, settledEndpoints: 0 },
  } as never;
  const back = overviewFromCache(JSON.parse(JSON.stringify(overviewToCache(overview))));
  assert.ok(back.rows[0]!.lastProbedAt instanceof Date);
  assert.equal(back.rows[0]!.lastProbedAt!.toISOString(), probed.toISOString());
  assert.equal(back.rows[1]!.lastProbedAt, null);
  assert.deepEqual(back.verdictCounts, (overview as { verdictCounts: unknown }).verdictCounts);
  assert.equal(back.totalEndpoints, 2);
});
