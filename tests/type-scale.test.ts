import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the public type scale is the eight steps, and body stays 15px on a small screen", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  for (const step of [
    "--type-12: 0.75rem",
    "--type-13: 0.84375rem",
    "--type-15: 0.9375rem",
    "--type-17: 1.0625rem",
    "--type-20: 1.25rem",
    "--type-28: 1.75rem",
    "--type-44: 2.75rem",
    "--type-64: 4rem",
  ]) {
    assert.ok(css.includes(step), step);
  }
  assert.match(css, /body\s*\{[^}]*font-size:\s*var\(--type-15\)/);
  assert.equal(css.includes("0.6875rem"), false, "11px is off the scale");
  assert.match(css, /\.fact-table th\s*\{[^}]*font-size:\s*var\(--type-12\)/);
  assert.match(css, /--section-gap:\s*4rem/);
  assert.doesNotMatch(css, /@media \(max-width: 640px\) \{\s*body \{/, "a small screen does not shrink the body");
  assert.match(css, /animation-delay:\s*1\.28s/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.gap-line\s*\{[^}]*animation:\s*none !important/);
});
