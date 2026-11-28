// Listing draft generation from openapi (I5).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_REGISTRY_PUBLISHED_LATEST,
  compareSemver,
  generateListingFiles,
  LISTING_OUTPUT_PATHS,
} from "@/lib/listings/generate-from-openapi";
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

function runGenerator(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/listings/generate.ts"), "--root", root, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function tempRepoCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "listings-drift-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "packages/mcp-server"), { recursive: true });
  copyFileSync(join(ROOT, "docs/openapi.yaml"), join(dir, "docs/openapi.yaml"));
  copyFileSync(join(ROOT, "packages/mcp-server/package.json"), join(dir, "packages/mcp-server/package.json"));
  return dir;
}

test("--check exits 0 with drift 0 right after generate, per destination", () => {
  const dir = tempRepoCopy();
  try {
    assert.equal(runGenerator(dir).status, 0);
    const out = runGenerator(dir, "--check");
    assert.equal(out.status, 0, out.stdout + out.stderr);
    for (const dest of Object.keys(LISTING_OUTPUT_PATHS) as ListingDestination[]) {
      assert.match(out.stdout, new RegExp(`drift_lines=0 path=${LISTING_OUTPUT_PATHS[dest].replace(/[.]/g, "\\.")}`));
    }
    assert.match(out.stdout, /listings: total_drift_lines=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check counts drift on the edited destination and exits 1; --observe exits 0", () => {
  const dir = tempRepoCopy();
  try {
    assert.equal(runGenerator(dir).status, 0);
    const target = join(dir, LISTING_OUTPUT_PATHS["x402-ecosystem"]);
    writeFileSync(target, readFileSync(target, "utf8").replace('"name": "vet402"', '"name": "edited"'));
    const strict = runGenerator(dir, "--check");
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /x402\.org metadata\.json: drift_lines=1 /);
    assert.match(strict.stdout, /openapi\.json: drift_lines=0 path=data\/listings\/openapi\.json/);
    const observe = runGenerator(dir, "--check", "--observe");
    assert.equal(observe.status, 0);
    assert.match(observe.stdout, /listings: total_drift_lines=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an openapi edit reaches the generated drafts", () => {
  const dir = tempRepoCopy();
  try {
    const yamlPath = join(dir, "docs/openapi.yaml");
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace("name: rwa-facts", "name: rwa-facts-edited"));
    assert.equal(runGenerator(dir).status, 0);
    assert.match(readFileSync(join(dir, LISTING_OUTPUT_PATHS["pay-sh-paymd"]), "utf8"), /name: 'rwa-facts-edited'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp server.json version is not below the version already published in the MCP registry", () => {
  const doc = JSON.parse(readFileSync(join(ROOT, "data/listings/mcp/server.json"), "utf8")) as { version?: string };
  assert.ok(compareSemver(doc.version ?? "", MCP_REGISTRY_PUBLISHED_LATEST) >= 0, `${doc.version} < ${MCP_REGISTRY_PUBLISHED_LATEST}`);
  // 2026-11-28 に registry.modelcontextprotocol.io で見た公開済みの最新版。下げない。
  assert.ok(compareSemver(MCP_REGISTRY_PUBLISHED_LATEST, "1.0.2") >= 0);
  // npm の @vet402/mcp-server の版（0.3.x）を MCP レジストリの版に使わない。
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/mcp-server/package.json"), "utf8")) as { version: string };
  if (compareSemver(pkg.version, MCP_REGISTRY_PUBLISHED_LATEST) < 0) assert.notEqual(doc.version, pkg.version);
});

test("compareSemver orders by major, minor, patch and rejects other forms", () => {
  assert.ok(compareSemver("1.0.2", "0.3.3") > 0);
  assert.ok(compareSemver("1.0.10", "1.0.2") > 0);
  assert.equal(compareSemver("1.0.2", "1.0.2"), 0);
  assert.throws(() => compareSemver("1.0", "1.0.2"), /MAJOR\.MINOR\.PATCH/);
});

test("the generator stops when the openapi serverVersion is below the published version", () => {
  const dir = tempRepoCopy();
  try {
    const yamlPath = join(dir, "docs/openapi.yaml");
    const yaml = readFileSync(yamlPath, "utf8");
    assert.match(yaml, /serverVersion: 1\.0\.2/);
    writeFileSync(yamlPath, yaml.replace("serverVersion: 1.0.2", "serverVersion: 0.3.3"));
    const out = runGenerator(dir);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /below the published 1\.0\.2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
