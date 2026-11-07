// ============================================================
// vet402 — /impact leads with what exists (2026-11-08).
//
// The Abstract states the published results first. The limits of the hash
// chain are moved to §4, not removed: §4 must still say that a root not
// fixed outside vet402 can be recomputed by the operator.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/app/impact/page.tsx", "utf8");
const abstract = src.slice(src.indexOf(">Abstract<"), src.indexOf('<span className="sec-no">1.</span>'));
const sec4 = src.slice(src.indexOf('<span className="sec-no">4.</span>'), src.indexOf('<span className="sec-no">5.</span>'));

test("the Abstract leads with the published results and points to §4", () => {
  assert.match(abstract, /actually buying from it/);
  assert.match(abstract, /CC BY 4\.0/);
  assert.match(abstract, /code is MIT/);
  assert.match(abstract, /is in §4\./);
  assert.doesNotMatch(abstract, /not yet enabled/);
});

test("§4 still states the chain's limits in full", () => {
  assert.match(sec4, /not yet fixed anywhere outside vet402/);
  assert.match(sec4, /could still\s+recompute the whole chain/);
});
