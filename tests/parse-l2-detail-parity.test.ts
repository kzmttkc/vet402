// ============================================================
// parseL2Detail: 96bf8dc3^ の seller-facts 内関数と export の一致（2026-10-28 点検）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseL2Detail, type PurchaseInput } from "@/lib/decision/seller-facts";

/** git 96bf8dc3^:src/lib/decision/seller-facts.ts の parseL2Detail（コピー）。 */
function legacyParseL2Detail(v: unknown): PurchaseInput["l2Detail"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.responseHash !== "string") return null;
  return {
    missing: Array.isArray(o.missing) ? o.missing.filter((k): k is string => typeof k === "string") : [],
    declarationHash: typeof o.declarationHash === "string" ? o.declarationHash : null,
    responseHash: o.responseHash,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}

const cases: unknown[] = [
  null,
  undefined,
  "string",
  42,
  [],
  {},
  { responseHash: 1 },
  { responseHash: "abc" },
  { responseHash: "abc", missing: ["a", 2, "b"], declarationHash: "decl", reason: "truncated_json" },
  { responseHash: "abc", missing: "nope", declarationHash: 9, reason: 1 },
  { responseHash: "deadbeef", missing: [], declarationHash: null, reason: null },
];

test("parseL2Detail matches legacy for rows with and without responseHash", () => {
  for (const c of cases) {
    assert.deepEqual(parseL2Detail(c), legacyParseL2Detail(c), JSON.stringify(c));
  }
});
