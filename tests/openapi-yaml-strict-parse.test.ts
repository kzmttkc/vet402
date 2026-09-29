// ============================================================
// 配信中の openapi.yaml が厳密な YAML パーサで読めること（2026-09-29 監査 7 周目）。
//
// `description: Pass back as ?cursor= …` の引用符なしの値が flow mapping の中にあり、PyYAML（コード生成・
// 多くの OpenAPI ツールの下にある）では `expected ',' or '}', but got '?'` で読めなかった。JS 側の読み手は
// 寛容で通っていたので、PyYAML で読む。python3 か PyYAML が無い環境では skip（落とさない）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SPEC = join(process.cwd(), "docs", "openapi.yaml");
const probe = spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" });
const available = !probe.error && probe.status === 0;

test("docs/openapi.yaml は PyYAML の safe_load で読める", { skip: available ? false : "python3 with PyYAML is not available" }, () => {
  const r = spawnSync("python3", ["-c", "import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding='utf-8'))", SPEC], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
