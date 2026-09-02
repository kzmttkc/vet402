// ============================================================
// vet402 — openapi ↔ route parity (2026-08-19).
//
// llms.txt tells machines the OpenAPI spec covers "every public endpoint", and
// the product's whole thesis is that its machine-readable layer says the same
// thing as its human layer. A public route that ships without an openapi entry
// quietly breaks both. This test enumerates the real App Router API routes and
// asserts every PUBLIC one is documented, so the next undocumented public
// endpoint fails CI instead of a hand audit.
//
// Intentionally-undocumented routes are allow-listed with the reason, so the
// list itself is the audit trail:
//   - internal surfaces (admin / cron / dashboard / billing / signup) are not
//     part of the public contract;
//   - the catch-all 404 handler is not an endpoint;
//   - guarantee/quote is a DORMANT financial product that returns 404 until
//     underwriting is enabled and MUST NOT be discoverable in the spec
//     (src/app/api/v1/guarantee/quote/route.ts states this).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Every dir under src/app/api that holds a route.ts, as an API path. */
function routePaths(): string[] {
  const base = join(ROOT, "src/app/api");
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(dir, entry.name);
      const seg = entry.name;
      const path = `${prefix}/${seg}`;
      if (readdirSync(sub).includes("route.ts")) out.push(path);
      walk(sub, path);
    }
  };
  walk(base, "/api");
  return out;
}

// Bracketed dynamic segments → openapi braces; drop a trailing `.svg` so the
// badge routes (served with the suffix, documented with or without it) compare
// equal either way.
const normalize = (p: string) =>
  p.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, "{$1}").replace(/\.svg$/, "");

const INTERNAL_PREFIXES = [
  "/api/admin/",
  "/api/cron/",
  "/api/dashboard/",
  "/api/billing/",
];
const ALLOWLIST = new Set([
  "/api/signup", // dashboard signup, not a public data endpoint
  "/api/{unmatched}", // the 404 catch-all ([...unmatched]), not an endpoint
  "/api/v1/guarantee/quote", // DORMANT — must stay undiscoverable until enabled
  // 2026-09-02 段 2: /observatory/e/[id] の通知・異議フォームの送信先（ブラウザ専用、
  // キー不要）。docs/openapi.yaml は同日の契約漂流の是正（別ブランチ）が持つので、
  // そちらで文書化するまでの暫定。文書化したらこの行を消す。
  "/api/v1/observatory/endpoints/{id}/subscribe",
]);

test("every public API route is documented in openapi.yaml", () => {
  const spec = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");
  // Match documented path keys: lines like `  /api/...:` under `paths:`.
  const documented = new Set(
    [...spec.matchAll(/^\s{2}(\/api\/[^\s:]+):/gm)].map((m) => normalize(m[1])),
  );

  const missing: string[] = [];
  for (const route of routePaths()) {
    const norm = normalize(route);
    if (INTERNAL_PREFIXES.some((p) => route.startsWith(p))) continue;
    if (ALLOWLIST.has(norm)) continue;
    if (!documented.has(norm)) missing.push(route);
  }

  assert.deepEqual(
    missing,
    [],
    `Public API routes missing from docs/openapi.yaml: ${missing.join(", ")}. ` +
      "Document them, or add to ALLOWLIST with the reason if intentionally private.",
  );
});
