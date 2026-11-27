// Listing draft generation from openapi (I5).
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { generateListingFiles, LISTING_OUTPUT_PATHS } from "@/lib/listings/generate-from-openapi";
import { loadOpenApiFromRepo } from "@/lib/listings/load-openapi";
import { countLineDrift, stableStringify } from "@/lib/listings/stable-json";
import type { ListingDestination } from "@/lib/listings/types";

const ROOT = process.cwd();

test("generateListingFiles is deterministic for the same openapi input", () => {
  const spec = loadOpenApiFromRepo(ROOT);
  const a = generateListingFiles(spec, ROOT);
  const b = generateListingFiles(spec, ROOT);
  for (const dest of Object.keys(LISTING_OUTPUT_PATHS) as ListingDestination[]) {
    assert.equal(a[dest], b[dest], dest);
  }
});

test("committed listing drafts match generator output (drift 0)", () => {
  const spec = loadOpenApiFromRepo(ROOT);
  const generated = generateListingFiles(spec, ROOT);
  for (const dest of Object.keys(LISTING_OUTPUT_PATHS) as ListingDestination[]) {
    const onDisk = readFileSync(join(ROOT, LISTING_OUTPUT_PATHS[dest]), "utf8");
    assert.equal(countLineDrift(generated[dest], onDisk), 0, LISTING_OUTPUT_PATHS[dest]);
  }
});

test("countLineDrift reports differing lines", () => {
  assert.equal(countLineDrift("a\nb\n", "a\nb\n"), 0);
  assert.equal(countLineDrift("a\nb\n", "a\nc\n"), 1);
  assert.equal(countLineDrift("a\n", "a\nb\n"), 1);
});

test("stableStringify sorts object keys", () => {
  const once = stableStringify({ z: 1, a: { y: 2, b: 3 } });
  const twice = stableStringify({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(once, twice);
});

test("pay.sh PAY.md carries required frontmatter keys", () => {
  const text = readFileSync(join(ROOT, "data/listings/pay-sh/PAY.md"), "utf8");
  for (const key of ["name:", "title:", "description:", "use_case:", "category:", "service_url:", "openapi:", "path: 'openapi.json'"]) {
    assert.ok(text.includes(key), key);
  }
});

test("mcp server.json points at vet402 org repository", () => {
  const doc = JSON.parse(readFileSync(join(ROOT, "data/listings/mcp/server.json"), "utf8")) as {
    repository?: { url?: string };
    name?: string;
  };
  assert.equal(doc.name, "com.vet402/vet402");
  assert.match(doc.repository?.url ?? "", /github\.com\/vet402\/vet402/);
});

test("bazaar declaration includes CDP bazaar info copied from payment terms", () => {
  const doc = JSON.parse(readFileSync(join(ROOT, "data/listings/bazaar/declarations.json"), "utf8")) as {
    declarations: Array<{ extensions?: { bazaar?: { info?: { input?: { method?: string } } } } }>;
  };
  assert.equal(doc.declarations.length, 1);
  assert.equal(doc.declarations[0]?.extensions?.bazaar?.info?.input?.method, "GET");
});

test("check mode detects drift against a temp copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "listings-drift-"));
  try {
    const spec = loadOpenApiFromRepo(ROOT);
    const generated = generateListingFiles(spec, ROOT);
    const dest = LISTING_OUTPUT_PATHS.openapi;
    const abs = join(dir, dest);
    mkdirSync(join(dir, "data/listings"), { recursive: true });
    writeFileSync(abs, generated.openapi);
    const mutated = generated.openapi.replace('"openapi": "3.1.0"', '"openapi": "3.1.1"');
    assert.ok(countLineDrift(mutated, generated.openapi) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});