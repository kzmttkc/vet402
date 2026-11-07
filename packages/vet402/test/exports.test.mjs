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

// Until vet402 is on npm, every README example that a reader can run today imports from the two
// published packages, and each imported name exists in the installed (npm) build.
test("README has runnable examples on @vet402/sdk and @vet402/middleware, and their names exist", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const today = [...readme.matchAll(/import \{([^}]+)\} from "(@vet402\/(?:sdk|middleware))";/g)];
  const pkgs = new Set(today.map((m) => m[2]));
  assert.ok(pkgs.has("@vet402/sdk") && pkgs.has("@vet402/middleware"), "README shows both published packages");
  for (const m of today) {
    const mod = m[2] === "@vet402/sdk" ? sdk : middleware;
    for (const n of m[1].split(",").map((x) => x.trim()).filter(Boolean)) assert.ok(n in mod, `${m[2]} has no export ${n}`);
  }
  assert.match(readme, /Not yet on npm/);
  // Values the reader fills are named, not left undefined.
  assert.match(readme, /const payee = "/);
  assert.match(readme, /const payerAddress = "/);
});
