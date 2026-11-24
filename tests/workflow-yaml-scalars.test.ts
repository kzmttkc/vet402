// 2026-11-24: observatory-snapshot.yml had `run: echo "skipped: no token"`. The ": " inside an
// unquoted scalar is invalid YAML, so GitHub failed the workflow file on every push to main.
// This checks every workflow for an unquoted one-line value that contains ": ".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), ".github", "workflows");

test("workflow one-line values with ': ' are quoted or block scalars", () => {
  const bad: string[] = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    readFileSync(path.join(DIR, f), "utf8").split("\n").forEach((line, i) => {
      const m = line.match(/^\s*(?:-\s+)?[A-Za-z_][\w-]*:\s+(.+)$/);
      if (!m) return;
      const v = m[1].trim();
      if (/^["'|>{\[&*!]/.test(v) || v.startsWith("${{")) return;
      const noComment = v.replace(/\s+#.*$/, "");
      if (/:\s/.test(noComment)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
