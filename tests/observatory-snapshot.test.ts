// observatory-snapshot workflow と bundle の manifest 連鎖。公開 GET は叩かない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const YML = join(process.cwd(), ".github/workflows/observatory-snapshot.yml");

test("workflow: 月曜 02:00 UTC、token 無しは skipped: no token で緑", () => {
  const yml = readFileSync(YML, "utf8");
  assert.match(yml, /cron: "0 2 \* \* 1"/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /default: kzmttkc\/vet402-observatory-data/);
  assert.match(yml, /skipped: no token/);
  assert.match(yml, /if: steps\.gate\.outputs\.run != 'true'/);
  assert.match(yml, /SNAPSHOT_REPO_TOKEN/);
  assert.doesNotMatch(yml, /SNAPSHOT_REPO_TOKEN:\s*[a-zA-Z0-9_]{20,}/);
});

test("workflow: push 前に manifest 連鎖を検査する", () => {
  const yml = readFileSync(YML, "utf8");
  assert.match(yml, /--check-chain/);
  assert.match(yml, /--prev-manifest/);
  assert.match(yml, /gh release create/);
});