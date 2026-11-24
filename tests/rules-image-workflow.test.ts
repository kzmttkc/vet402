// rules-image.yml: 権限・オフライン検証・YAML の読みやすさ（workflow-yaml-scalars と別枠）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const YML = join(process.cwd(), ".github/workflows/rules-image.yml");

test("rules-image workflow: YAML loads and triggers are wired", () => {
  const yml = readFileSync(YML, "utf8");
  assert.match(yml, /^name: rules-image/m);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /branches: \[main\]/);
  assert.match(yml, /Dockerfile\.rules/);
  assert.match(yml, /scripts\/decide-cli\.ts/);
  assert.match(yml, /src\/lib\/decision\/\*\*/);
  assert.match(yml, /docker\/build-push-action@[0-9a-f]{40}/);
  assert.match(yml, /ghcr\.io\/vet402\/vet402-rules/);
});

test("rules-image workflow: permissions are contents read and packages write only", () => {
  const yml = readFileSync(YML, "utf8");
  const block = /^permissions:\n((?:  .+\n)+)/m.exec(yml)?.[1] ?? "";
  const keys = [...block.matchAll(/^  ([\w-]+):/gm)].map((m) => m[1]);
  assert.deepEqual([...keys].sort(), ["contents", "packages"]);
  assert.match(block, /contents: read/);
  assert.match(block, /packages: write/);
});

test("rules-image workflow: fixture verification uses --network none", () => {
  const yml = readFileSync(YML, "utf8");
  assert.match(yml, /docker run --rm -i --network none/); // -i: without it stdin never reaches the container (2026-11-25 first run)
  assert.match(yml, /fixtures\/decide\/\*\.json/);
  assert.match(yml, /GITHUB_STEP_SUMMARY/);
});