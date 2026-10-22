import { test } from "node:test";
import assert from "node:assert/strict";
import { ratioParts } from "@/lib/figures/share";

test("ratioParts splits answered 2xx from the rest of a whole", () => {
  const even = ratioParts(1, 4);
  assert.deepEqual(even, { solidPct: 25, hatchPct: 75 });
  assert.equal(ratioParts(0, 10)?.solidPct, 0);
  assert.equal(ratioParts(0, 10)?.hatchPct, 100);
  assert.equal(ratioParts(10, 10)?.hatchPct, 0);
  const over = ratioParts(12, 10);
  assert.equal(over?.solidPct, 100);
  assert.equal(over?.hatchPct, 0);
  assert.equal(ratioParts(3, 0), null);
  assert.equal(ratioParts(-1, 10), null);
  assert.equal(ratioParts(Number.NaN, 10), null);
  assert.equal(ratioParts(1, Number.POSITIVE_INFINITY), null);
});
