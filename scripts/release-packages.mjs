#!/usr/bin/env node
// ============================================================
// Vouch — publish the SDK, the MCP server, the middleware and the vet402 package to npm.
//
// WHY THIS SCRIPT EXISTS. The two packages were finished and never published:
// both carried `"private": true`, so `npm publish` refused, and the obvious
// fix (delete that line) does not work either — the `@vouch` scope is owned by
// someone else on npm, as are `vouch`, `vouch-sdk` and `agent-trust-sdk`.
// The repo now uses `@vouchscore`, which was verified free.
//
// The publish itself is a human action (it needs an npm login this process
// must never handle, and it is irreversible for 72 hours), so this script does
// everything up to that point and then asks. It:
//   1. refuses to run on a dirty tree — a published tarball must correspond to
//      a commit somebody can check out;
//   2. builds each package from source;
//   3. runs each package's tests;
//   4. shows `npm publish --dry-run` for each, i.e. the exact file list;
//   5. asks for a typed confirmation before publishing anything.
//
// Usage:
//   npm login          # once, in this terminal
//   npm run release:packages
//   npm run release:packages -- --dry-run   # stop after step 4
// ============================================================
import { execFileSync, execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["packages/sdk", "packages/mcp-server", "packages/middleware", "packages/vet402"];
const DRY_RUN_ONLY = process.argv.includes("--dry-run");

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

const capture = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: process.env });

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ---- 1. clean tree ---------------------------------------------------------
const dirty = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" }).trim();
if (dirty) {
  fail(
    "the working tree has uncommitted changes. Commit or stash first — a published\n" +
      "  version has to match a commit, or nobody can tell what they installed.\n\n" +
      dirty,
  );
}

// ---- 2. who are we publishing as? -----------------------------------------
let whoami = "";
try {
  whoami = capture("npm", ["whoami"], ROOT).trim();
} catch {
  fail("not logged in to npm. Run `npm login` in this terminal first.");
}

// 2026-11-08: vet402 (one package for both sides) is published under its own unscoped name, which
// the owner claimed on npm. Every other package stays under the scope.
const UNSCOPED_OK = new Set(["vet402"]);

const manifests = PACKAGES.map((dir) => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
  if (pkg.private) fail(`${dir} still has "private": true`);
  if (!pkg.name.startsWith("@") && !UNSCOPED_OK.has(pkg.name)) fail(`${dir} has an unscoped name (${pkg.name})`);
  if (pkg.publishConfig?.access !== "public") {
    fail(`${dir} is missing publishConfig.access = "public" (a scoped package defaults to private)`);
  }
  return { dir, pkg };
});

const scope = manifests[0].pkg.name.split("/")[0];
console.log(`\nnpm user : ${whoami}`);
console.log(`scope    : ${scope}`);
for (const { pkg } of manifests) console.log(`package  : ${pkg.name}@${pkg.version}`);

// ---- 3. build + test -------------------------------------------------------
for (const { dir } of manifests) {
  console.log(`\n── building ${dir} ──`);
  run("npm", ["install", "--no-audit", "--no-fund"], path.join(ROOT, dir));
  run("npm", ["run", "build"], path.join(ROOT, dir));
}

console.log("\n── SDK tests ──");
run("npm", ["test"], path.join(ROOT, "packages/sdk"));

console.log("\n── middleware tests ──");
run("npm", ["test"], path.join(ROOT, "packages/middleware"));

// 2026-08-22: mcp-server は公開 npm バイナリなのにテストが無く、
// ここでも回されていなかった。テストを入れたので出荷前の関門に加える。
console.log("\n── mcp-server tests ──");
run("npm", ["test"], path.join(ROOT, "packages/mcp-server"));

// 2026-11-08: vet402 re-exports @vet402/sdk and @vet402/middleware from npm. When either is bumped in the
// same release, publish it first and run `npm install` in packages/vet402 again before this step.
console.log("\n── vet402 tests ──");
run("npm", ["test"], path.join(ROOT, "packages/vet402"));

// ---- 4. dry run ------------------------------------------------------------
for (const { dir } of manifests) {
  console.log(`\n── npm publish --dry-run: ${dir} ──`);
  run("npm", ["publish", "--dry-run", "--access", "public"], path.join(ROOT, dir));
}

if (DRY_RUN_ONLY) {
  console.log("\n--dry-run given: stopping before publish.\n");
  process.exit(0);
}

// ---- 5. confirm ------------------------------------------------------------
console.log(
  "\nAbout to publish the packages above to the public npm registry.\n" +
    "This is irreversible: a published version can be deprecated but not replaced,\n" +
    "and unpublishing is only allowed within 72 hours.\n",
);
const rl = createInterface({ input: stdin, output: stdout });
const answer = (await rl.question(`Type "publish" to continue: `)).trim();
rl.close();

if (answer !== "publish") {
  console.log("\nAborted. Nothing was published.\n");
  process.exit(0);
}

for (const { dir, pkg } of manifests) {
  console.log(`\n── publishing ${pkg.name}@${pkg.version} ──`);
  run("npm", ["publish", "--access", "public"], path.join(ROOT, dir));
}

console.log(
  `\n✓ published.\n\n  npm view ${manifests[0].pkg.name}\n  npx ${manifests[1].pkg.name.split("/")[1] === "mcp-server" ? manifests[1].pkg.name : ""}\n\n` +
    "Next: the ecosystem lists (awesome-agentic-commerce, awesome-x402,\n" +
    "awesome-x402-servers, awesome-erc8004) — those PRs are outbound and need\n" +
    "approval before they are opened.\n",
);
