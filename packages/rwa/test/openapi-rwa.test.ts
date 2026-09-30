// The /rwa section of docs/openapi.yaml names every gap and every look-alike reason
// the code can write (rwa-recon-0.3), so the published enums cannot drift.
//
// Run from the repo root: npx tsx --test packages/rwa/test/openapi-rwa.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { METHOD_VERSION } from "../facts";

const root = process.cwd();
const yaml = readFileSync(join(root, "docs/openapi.yaml"), "utf8");
const section = yaml.slice(yaml.indexOf("  /api/v1/rwa/facts/{address}:"), yaml.indexOf("  /api/v1/rwa/paid/facts/{address}:"));

/** The `- item` lines right under `key:` ... `enum:` inside the section. */
function enumAfter(marker: string): string[] {
  const at = section.indexOf(marker);
  assert.ok(at >= 0, `openapi /rwa section has no ${marker}`);
  const rest = section.slice(at).split("\n");
  const start = rest.findIndex((l) => l.trim() === "enum:");
  const out: string[] = [];
  for (const l of rest.slice(start + 1)) {
    const m = /^\s+- ([a-z_]+)$/.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out.sort();
}

test("every gap facts.ts can add is in the published enum, and nothing else", () => {
  const src = readFileSync(join(root, "packages/rwa/facts.ts"), "utf8");
  const inCode = [...new Set([...src.matchAll(/gaps\.add\("([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
  assert.ok(inCode.length > 5);
  assert.deepEqual(enumAfter("                  gaps:"), inCode);
});

test("every look-alike reason is in the published enum, and nothing else", () => {
  const src = readFileSync(join(root, "packages/rwa/lookalike.ts"), "utf8");
  const type = src.slice(src.indexOf("export type LookalikeReason"), src.indexOf(";", src.indexOf("export type LookalikeReason")));
  const inCode = [...type.matchAll(/\| "([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.ok(inCode.length > 5);
  assert.deepEqual(enumAfter("                        reasons:"), inCode);
});

test("the published example method_version is the current one", () => {
  assert.match(section, new RegExp(`method_version: \\{ type: string, example: ${METHOD_VERSION.replace(/\./g, "\\.")} \\}`));
});
