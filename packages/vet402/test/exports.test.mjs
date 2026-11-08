// The subpath exports resolve from the package name and expose the same
// functions as the source packages (identity, not copies).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as root from "vet402";
import * as buyer from "vet402/buyer";
import * as seller from "vet402/seller";
import * as sdk from "@vet402/sdk";
import * as middleware from "@vet402/middleware";

test("vet402 (root) exposes check", () => {
  assert.equal(typeof root.check, "function");
});

test("vet402/buyer re-exports every value export of @vet402/sdk, plus check", () => {
  for (const name of Object.keys(sdk)) assert.equal(buyer[name], sdk[name], `buyer.${name}`);
  for (const name of ["payOrRefuse", "SpendGuard", "createVouchClient", "VouchApiError"]) assert.equal(typeof buyer[name], "function", name);
  assert.equal(buyer.check, root.check);
});

test("vet402/seller re-exports every value export of @vet402/middleware", () => {
  for (const name of Object.keys(middleware)) assert.equal(seller[name], middleware[name], `seller.${name}`);
  assert.equal(typeof seller.createTrustGate, "function");
});

test("package.json declares the three entry points with types", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "vet402");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.type, "module");
  for (const k of [".", "./buyer", "./seller"]) {
    assert.ok(pkg.exports[k].types, k);
    assert.ok(pkg.exports[k].import, k);
  }
  assert.deepEqual(pkg.files, ["dist", "README.md"]);
});

test("README leads with the product sentence", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("Put vet402 between AI agents. Both sides trade safely."));
});

// vet402 is on npm (0.1.0, 2026-11-08). The README examples import from vet402, vet402/buyer and
// vet402/seller, and each imported name exists in this package's build.
test("README examples import from vet402 and its subpaths, and their names exist", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const mods = { vet402: root, "vet402/buyer": buyer, "vet402/seller": seller };
  const found = [...readme.matchAll(/import \{([^}]+)\} from "(vet402(?:\/buyer|\/seller)?)";/g)];
  assert.deepEqual([...new Set(found.map((m) => m[2]))].sort(), ["vet402", "vet402/buyer", "vet402/seller"]);
  for (const m of found) {
    for (const n of m[1].split(",").map((x) => x.trim()).filter(Boolean)) assert.ok(n in mods[m[2]], `${m[2]} has no export ${n}`);
  }
  assert.doesNotMatch(readme, /not yet on npm/i);
  assert.match(readme, /npm install vet402/);
  assert.match(readme, /const payee = "/);
  assert.match(readme, /const payerAddress = "/);
});
