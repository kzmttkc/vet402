// ============================================================
// 本番 DB のホスト名を公開面に書けない（2026-09-09 敵対的監査・所見 2）。
//
// Neon のエンドポイント名（`ep-<word>-<word>-<8 chars>.…aws.neon.tech`）は、それだけでは
// 接続できないが「どのプロジェクトのどのブランチか」を一意に指す。09-07 `bb56b1a` で
// docs/handoffs/CHANGELOG.md から消したものが 09-08 `10b9dc4` で再掲された——規律では
// 二度目を止められなかったので、tests/pg-test-guard.test.ts と同じく計器にする。
//
// 対象は審査員が読む公開面: docs/**・README.md・SKILL.md（root と skills/**）・src/app/**。
// `.env*` は対象外（そもそも git に無い）。履歴は書き換えない（force-push 禁止）ので、
// このゲートが守るのは「これから先の main」だけ。
// ============================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

/** 禁止形。正解（本物のホスト名）はここに書かない——正典が 2 つになる。 */
const PROD_HOST_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "neon-aws-host", re: /\.aws\.neon\.tech\b/i },
  // `\b` が要る: docs.world.org の `#step-2-register-…` は `ep-` を含む（実測・偽陽性）。
  { name: "neon-endpoint-id", re: /\bep-[a-z0-9-]{20,}/ },
];

function findProdHostLeaks(text: string): string[] {
  return PROD_HOST_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

const ROOT = process.cwd();
const SCOPE_DIRS = ["docs", "src/app", "skills"];
const SCOPE_FILES = ["README.md", "SKILL.md"];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|mp4|m4a|woff2?|zip)$/i;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (!BINARY_EXT.test(name)) out.push(p);
  }
  return out;
}

function publicSurfaceFiles(): string[] {
  const files: string[] = [];
  for (const d of SCOPE_DIRS) {
    try {
      if (statSync(join(ROOT, d)).isDirectory()) walk(join(ROOT, d), files);
    } catch {
      /* dir absent: nothing to scan */
    }
  }
  for (const f of SCOPE_FILES) {
    try {
      if (statSync(join(ROOT, f)).isFile()) files.push(join(ROOT, f));
    } catch {
      /* file absent */
    }
  }
  return files;
}

test("本番 Neon ホスト名の形は検出する（-pooler 付き・database 名付き・裸のエンドポイント名）", () => {
  for (const s of [
    "postgresql://u:p@ep-example-000000-pooler.us-east-2.aws.neon.tech/vouch?sslmode=require",
    "`ep-odd-example-a1b2c3d4.c-3.us-east-2.aws.neon.tech`",
    "host ep-odd-example-a1b2c3d4 (no domain)",
  ]) {
    assert.ok(findProdHostLeaks(s).length > 0, s);
  }
});

test("置換後の表記・一般名・偽陽性の実例は通す", () => {
  for (const s of [
    "Neon の `vouch` database（`<prod-host>`。`/neondb` ではありません）",
    "- [Neon](https://neon.tech) project (PostgreSQL)",
    "https://docs.world.org/agents/agent-kit/integrate#step-2-register-the-agent-in-agentbook",
    "postgres://takeshi@localhost:5432/vet402test",
    "deep-dive-into-the-x402-protocol-2026",
  ]) {
    assert.deepEqual(findProdHostLeaks(s), [], s);
  }
});

test("公開面（docs/**・README.md・SKILL.md・skills/**・src/app/**）に本番ホスト名が無い", () => {
  const files = publicSurfaceFiles();
  assert.ok(files.length >= 50, `走査対象が少なすぎる: ${files.length}`);
  const leaks: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const names = findProdHostLeaks(text);
    // 値そのものは書かない（テスト出力がログに残る）。ファイルと種別だけ。
    if (names.length > 0) leaks.push(`${relative(ROOT, f)}: ${names.join(",")}`);
  }
  assert.deepEqual(leaks, [], `本番ホスト名が公開面にある:\n${leaks.join("\n")}`);
});
