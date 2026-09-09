// ============================================================
// Agent Skill + Claude Code plugin の関門（2026-09-09・ETHOnline 2026 The Graph "AI Tooling" 賞向け）。
//
// WHY. 賞ページは "agent SKILLs" と "a clear README or SKILL.md so judges can run it" を求め、
// 参照先に The Graph 自身の skills リポ（graphprotocol/subgraphs-skills・streamingfast/substreams-skills）
// を置く。どちらも `skills/<name>/SKILL.md`（Agent Skills の frontmatter）＋ `.claude-plugin/plugin.json`。
// 同じ形で `skills/pay-or-refuse/SKILL.md` と `.claude-plugin/plugin.json` を同梱した。
//
// 文書は毎日古くなる。root SKILL.md の腐りは skill-live-check が拾うが、こちらのスキルは
// 「理由コードの表」が主役で、表は SDK / MCP の定数から**手で写した**もの。写しは正典が動くと嘘になる。
// だから正解を書き写さず、正典（PAY_REFUSE_REASONS・REFUSE_REASONS・実装の文字列）から導出して突き合わせる。
//
// 守るもの:
//   1. frontmatter が Agent Skills 仕様どおり（name ≤64・[a-z0-9-]・"anthropic"/"claude" を含まない、
//      description 非空 ≤1024、XML タグ無し、鍵は仕様の 6 つだけ、`---` が 1 行目）
//   2. plugin.json が JSON として読め、name が kebab-case、skills の各パスに SKILL.md が実在し、
//      mcpServers がリポ内の packages/mcp-server/dist を `node` で起動し（npm の 0.2.0 には pay_if_trusted が無い。
//      2026-09-09 検証役の実測: `npx -y @vet402/mcp-server` の tools/list は 5 本、ローカル dist は 7 本）、
//      VOUCH_API_URL が MCP の既定と一致する
//   3. スキルの理由コード表 ＝ SDK PAY_REFUSE_REASONS ∪ MCP REFUSE_REASONS ∪ {MCP 層が足す語, settle 経路の語}
//      （過不足ゼロ。表に無い語も、正典に無い語も赤）
//   4. スキル内の ```bash ブロックは全部 `# live:` 印を持つ（skill-live-check の会計規律をこちらにも）
//
// 一次: https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview（frontmatter の制約）
//       https://docs.claude.com/en/docs/claude-code/plugins-reference（manifest の schema）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PAY_REFUSE_REASONS } from "../packages/sdk/src/pay-or-refuse";
// main() only runs when argv[1] is the script itself, so importing is side-effect free.
import { extractBlocks } from "../scripts/skill-live-check.mjs";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// packages/mcp-server/src は `@vet402/sdk` を型 import しており、root の `tsc --noEmit`（CI の typecheck）
// では解決できない（2026-09-09 に CI run 34289157020 で赤）。他の parity テストと同じく本文から引く。
/** `export const NAME = [ "a", "b", ... ] as const;` の語を配列で返す。 */
function constStringArray(source: string, name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  assert.ok(m, `${name} が見つからない`);
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
}
const MCP_REFUSE_REASONS = constStringArray(read("packages/mcp-server/src/pay-if-trusted.ts"), "REFUSE_REASONS");
const MCP_DEFAULT_API_URL = (() => {
  const m = /export const DEFAULT_API_URL = "([^"]+)"/.exec(read("packages/mcp-server/src/vouch-client.ts"));
  assert.ok(m, "DEFAULT_API_URL が見つからない");
  return m[1];
})();

const SKILL_DIR = "skills/pay-or-refuse";
const SKILL_PATH = `${SKILL_DIR}/SKILL.md`;
const MANIFEST_PATH = ".claude-plugin/plugin.json";

/** Agent Skills 仕様が claude.ai / Skills API で受ける frontmatter の鍵（Claude Code はこれに拡張を足す）。 */
const SPEC_FRONTMATTER_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

/** `---` で囲まれた frontmatter を、鍵→生の値（複数行は結合）で返す。YAML パーサを足さない。 */
function parseFrontmatter(md: string): { keys: Map<string, string>; body: string } {
  const lines = md.split("\n");
  assert.equal(lines[0], "---", "SKILL.md の 1 行目が `---` ではない（Claude Code は 1 行目でしか frontmatter を読まない）");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, "frontmatter の閉じ `---` が無い");
  const keys = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines.slice(1, end)) {
    const top = /^([A-Za-z][A-Za-z0-9-]*):(.*)$/.exec(line);
    if (top) {
      current = top[1];
      keys.set(current, top[2].trim());
    } else if (current && /^\s+\S/.test(line)) {
      keys.set(current, `${keys.get(current) ?? ""}\n${line.trim()}`.trim());
    } else if (line.trim() !== "") {
      assert.fail(`frontmatter に読めない行: ${JSON.stringify(line)}`);
    }
  }
  return { keys, body: lines.slice(end + 1).join("\n") };
}

// ---------- 1. frontmatter ----------

test("skills/pay-or-refuse/SKILL.md の frontmatter は Agent Skills 仕様の制約を満たす", () => {
  const { keys } = parseFrontmatter(read(SKILL_PATH));

  const name = keys.get("name");
  assert.ok(name, "name が無い（必須）");
  assert.ok(name.length <= 64, `name が 64 文字を超える: ${name.length}`);
  assert.match(name, /^[a-z0-9-]+$/, "name は小文字・数字・ハイフンだけ");
  assert.doesNotMatch(name, /anthropic|claude/, "name に予約語 anthropic / claude を含めない");
  assert.equal(name, "pay-or-refuse", "name はディレクトリ名と揃える（plugin の呼び名になる）");

  const description = keys.get("description");
  assert.ok(description && description.trim().length > 0, "description が無い／空（必須）");
  assert.ok(description.length <= 1024, `description が 1024 文字を超える: ${description.length}`);
  assert.doesNotMatch(description, /<[a-zA-Z/][^>]*>/, "description に XML タグを含めない");
  // 仕様: 「何をするか」と「いつ使うか」の両方。後者は "Use when" で始まる 1 文で担保する。
  assert.match(description, /\bUse when\b/, "description に「いつ使うか」（Use when …）が無い");

  for (const k of keys.keys()) {
    assert.ok(SPEC_FRONTMATTER_KEYS.has(k), `frontmatter の鍵 ${k} は Agent Skills 仕様の 6 つに無い（claude.ai / Skills API は hard error）`);
  }
});

// ---------- 2. plugin.json ----------

test(".claude-plugin/plugin.json は manifest schema に沿い、指す先が実在する", () => {
  const manifest = JSON.parse(read(MANIFEST_PATH)) as Record<string, unknown>;
  const name = manifest.name;
  assert.equal(typeof name, "string", "name は必須（唯一の必須フィールド）");
  assert.match(name as string, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name は kebab-case");

  const skills = manifest.skills;
  assert.ok(Array.isArray(skills) && skills.length > 0, "skills は 1 件以上の配列");
  for (const p of skills as unknown[]) {
    assert.equal(typeof p, "string");
    const dir = join(ROOT, p as string);
    assert.ok(existsSync(join(dir, "SKILL.md")), `skills のパス ${p} に SKILL.md が無い`);
  }
  assert.ok((skills as string[]).includes(`./${SKILL_DIR}`), `skills に ./${SKILL_DIR} が無い`);

  // mcpServers はファイル参照（標準の MCP 設定）。インラインだと
  // `claude plugin details` の inventory が MCP servers (0) と数えた（2026-09-09 実測）。
  // 置き場は plugin root の `.mcp.json` **ではなく** `.claude-plugin/mcp.json`: root の `.mcp.json` は
  // リポを `claude` でプロジェクトとして開いたときにも読まれ、`${CLAUDE_PLUGIN_ROOT}` が解決できず
  // 「Missing environment variables」＋承認待ちを出した（2026-09-09 監査の実測）。manifest の path は
  // plugin root 相対で `./` から始まればよい（一次: plugins-reference の `"./my-extra-mcp-config.json"`）。
  assert.ok(!existsSync(join(ROOT, ".mcp.json")), "root に .mcp.json を置かない（プロジェクト MCP 設定として読まれ、${CLAUDE_PLUGIN_ROOT} が未解決の警告になる）");
  const mcpRef = manifest.mcpServers;
  assert.equal(typeof mcpRef, "string", "mcpServers は MCP 設定ファイルへのパス参照にする");
  assert.match(mcpRef as string, /^\.\//, "mcpServers の path は plugin root 相対で `./` から始める");
  assert.ok(existsSync(join(ROOT, mcpRef as string)), `mcpServers の参照先 ${mcpRef} が無い`);
  const mcpConfig = JSON.parse(read(mcpRef as string)) as { mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
  const servers = mcpConfig.mcpServers;
  assert.ok(servers && typeof servers === "object", `${mcpRef} に mcpServers が無い`);
  const entries = Object.values(servers);
  assert.equal(entries.length, 1, "MCP サーバーは 1 本（@vet402/mcp-server）");
  const [server] = entries;
  // npm の @vet402/mcp-server は 0.2.0（2026-08-24 公開）で pay_if_trusted を持たない。公開は提出後の方針なので、
  // プラグインは npx で npm 版を引かず、clone の dist を node で起動する（${CLAUDE_PLUGIN_ROOT} はプラグインの
  // インストール先＝clone の root。一次: https://code.claude.com/docs/en/plugins-reference）。
  assert.notEqual(server.command, "npx", "npx は npm 版（pay_if_trusted 無し）を起動してしまう——clone の dist を node で起動する");
  assert.equal(server.command, "node", "MCP サーバーはリポ内の dist を node で起動する");
  const ENTRY = "${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/dist/index.js";
  assert.deepEqual(server.args, [ENTRY], `args は [${ENTRY}] の 1 本（npm パッケージ名や相対パスを混ぜない）`);
  const entryOnDisk = join(ROOT, ENTRY.replace("${CLAUDE_PLUGIN_ROOT}/", ""));
  assert.ok(existsSync(entryOnDisk), `起動対象 ${entryOnDisk} がリポに無い（dist はコミットする方針）`);
  assert.match(readFileSync(entryOnDisk, "utf8"), /"pay_if_trusted"/, "起動対象の dist に pay_if_trusted が無い——dist が src より古い");
  assert.equal(server.env?.VOUCH_API_URL, MCP_DEFAULT_API_URL, "VOUCH_API_URL が MCP サーバーの既定と食い違う");
  for (const [k, v] of Object.entries(server.env ?? {})) {
    assert.doesNotMatch(k, /KEY|SECRET|PRIVATE/i, `manifest に鍵を置かない: ${k}`);
    assert.doesNotMatch(v, /^(vouch_live_|0x[0-9a-fA-F]{64})/, `manifest に鍵の値を置かない: ${k}`);
  }
});

// ---------- 3. 理由コードの表 ＝ 正典の和集合 ----------

/** 「## Reason codes」節の表から、1 列目のバッククォート付き語を全部取る。 */
function reasonCodesInSkillTable(md: string): string[] {
  const start = md.indexOf("\n## Reason codes");
  assert.ok(start >= 0, "SKILL.md に「## Reason codes」節が無い");
  const rest = md.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const codes: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\| `([a-z0-9_]+)` \|/.exec(line);
    if (m) codes.push(m[1]);
  }
  return codes;
}

/** 実装が文字列リテラルとして出している語。定数に無い語は実装の本文から引く（正解を書き写さない）。 */
function literalReasons(source: string, words: string[]): string[] {
  return words.filter((w) => {
    assert.ok(source.includes(`"${w}"`), `実装に "${w}" が無い——語が変わったなら表も変える`);
    return true;
  });
}

test("スキルの理由コード表は SDK PAY_REFUSE_REASONS ∪ MCP REFUSE_REASONS ∪ 実装が足す語と過不足なく一致する", () => {
  const inTable = reasonCodesInSkillTable(read(SKILL_PATH));
  assert.equal(new Set(inTable).size, inTable.length, `表に重複がある: ${inTable.join(", ")}`);

  const mcpIndex = read("packages/mcp-server/src/index.ts");
  const sdkGate = read("packages/sdk/src/pay-or-refuse.ts");
  const canon = new Set<string>([
    ...PAY_REFUSE_REASONS,
    ...MCP_REFUSE_REASONS,
    ...literalReasons(mcpIndex, ["payer_not_configured"]),
    ...literalReasons(sdkGate, ["settle_failed"]),
  ]);

  const missing = [...canon].filter((c) => !inTable.includes(c));
  const extra = inTable.filter((c) => !canon.has(c));
  assert.deepEqual(missing, [], `正典にあって表に無い語: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `表にあって正典に無い語: ${extra.join(", ")}`);
});

// ---------- 4. bash ブロックの会計 ----------

test("スキル内の ```bash ブロックは全部 `# live:` 印を持つ（skill-live-check と同じ規律）", () => {
  const { allBash, errors } = extractBlocks(read(SKILL_PATH)) as { allBash: unknown[]; errors: string[] };
  assert.deepEqual(errors, [], `印の無い／壊れた bash ブロック:\n  ${errors.join("\n  ")}`);
  assert.ok(allBash.length >= 1, "bash ブロックが 1 つも無い（Setup の起動例が消えた）");
});
