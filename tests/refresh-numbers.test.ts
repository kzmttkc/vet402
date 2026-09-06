// ============================================================
// scripts/refresh-numbers.mjs（2026-09-07 Takeshi 採用「提出直前に数字だけ拾って変える」を1コマンドに）。
//
// 提出物の文書に載る動く数字（テスト本数・会期のファイル数など）を
// `<!-- n:ID -->164<!-- /n -->` で囲み、`--refresh` がコマンドで再計算して書き換え、
// `--check` が「印の値 == scripts/refresh-numbers.json の記録値」を CI で見張る。
//
// --check はコマンドを実走しない（SDK/MCP の npm test は数十秒かかり、CI の test ジョブに鍵も無い）。
// 記録値は --refresh だけが更新する。だから「印だけ直した」「JSON だけ直した」のどちらも赤になる。
// ============================================================
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = join(process.cwd(), "scripts", "refresh-numbers.mjs");

type Literal = { doc: string; pattern: string };
type Num = {
  id: string;
  description: string;
  command: string;
  env?: string[];
  literal?: Literal[];
  value: string | null;
  updatedAt: string | null;
};

function fixture(opts: { docs: Record<string, string>; numbers: Num[] }) {
  const root = mkdtempSync(join(tmpdir(), "refresh-numbers-"));
  for (const [rel, body] of Object.entries(opts.docs)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const config = join(root, "numbers.json");
  writeFileSync(config, JSON.stringify({ docs: Object.keys(opts.docs), numbers: opts.numbers }, null, 2) + "\n");
  return { root, config };
}

function run(root: string, config: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--root", root, "--config", config], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const n = (id: string, value: string | null, extra: Partial<Num> = {}): Num => ({
  id,
  description: id,
  command: `echo ${value ?? 0}`,
  value,
  updatedAt: value === null ? null : "2026-09-07T00:00:00.000Z",
  ...extra,
});

test("(a) --check: 印の値が記録値と一致 → exit 0", () => {
  const { root, config } = fixture({
    docs: { "README.md": "tests: <!-- n:sdk_tests -->164<!-- /n --> pass\n" },
    numbers: [n("sdk_tests", "164")],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 0, r.out);
});

test("(b) --check: 不一致 → exit 1・id と文書名を印字", () => {
  const { root, config } = fixture({
    docs: {
      "README.md": "tests: <!-- n:sdk_tests -->164<!-- /n -->\n",
      "docs/X.md": "commits <!-- n:commits -->5<!-- /n -->\n",
    },
    numbers: [n("sdk_tests", "165"), n("commits", "5")],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sdk_tests/);
  assert.match(r.out, /README\.md/);
  assert.doesNotMatch(r.out, /X\.md.*commits|commits.*X\.md/, "一致している id を違反として出さない");
});

test("(c) --check: JSON にあるが印がどの文書にも無い id → exit 1", () => {
  const { root, config } = fixture({
    docs: { "README.md": "tests: <!-- n:sdk_tests -->164<!-- /n -->\n" },
    numbers: [n("sdk_tests", "164"), n("orphan_id", "9")],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /orphan_id/);
});

test("(d) --check: 文書にあるが JSON に無い印 → exit 1", () => {
  const { root, config } = fixture({
    docs: { "README.md": "<!-- n:sdk_tests -->164<!-- /n --> and <!-- n:unknown_mark -->3<!-- /n -->\n" },
    numbers: [n("sdk_tests", "164")],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unknown_mark/);
  assert.match(r.out, /README\.md/);
});

test("(e) --refresh --dry-run: 差分を印字するが文書も JSON も書き換えない", () => {
  const doc = "tests: <!-- n:sdk_tests -->164<!-- /n -->\n";
  const { root, config } = fixture({
    docs: { "README.md": doc },
    numbers: [n("sdk_tests", "164", { command: "echo 170" })],
  });
  const before = readFileSync(config, "utf8");
  const r = run(root, config, ["--refresh", "--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /sdk_tests/);
  assert.match(r.out, /164/);
  assert.match(r.out, /170/);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), doc);
  assert.equal(readFileSync(config, "utf8"), before);
});

test("--refresh: コマンドを実走して記録値と全文書の印を書き換える（同じ id が複数文書にあっても全部）", () => {
  const { root, config } = fixture({
    docs: {
      "README.md": "a <!-- n:sdk_tests -->164<!-- /n --> b\n",
      "docs/Y.md": "ℹ tests <!-- n:sdk_tests -->164<!-- /n -->\nℹ pass <!-- n:sdk_tests -->164<!-- /n -->\n",
    },
    numbers: [n("sdk_tests", "164", { command: "echo 170" })],
  });
  const r = run(root, config, ["--refresh"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "a <!-- n:sdk_tests -->170<!-- /n --> b\n");
  assert.equal(
    readFileSync(join(root, "docs/Y.md"), "utf8"),
    "ℹ tests <!-- n:sdk_tests -->170<!-- /n -->\nℹ pass <!-- n:sdk_tests -->170<!-- /n -->\n",
  );
  const json = JSON.parse(readFileSync(config, "utf8")) as { numbers: Num[] };
  assert.equal(json.numbers[0].value, "170");
  assert.match(json.numbers[0].updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  // 書き換えた直後の --check は緑
  assert.equal(run(root, config, ["--check"]).code, 0);
});

test("(f) --refresh: env が無い id は警告して skip、他の id は更新する", () => {
  const { root, config } = fixture({
    docs: { "README.md": "<!-- n:graph_receipts -->259<!-- /n --> / <!-- n:sdk_tests -->164<!-- /n -->\n" },
    numbers: [
      n("graph_receipts", "259", { command: "echo 999", env: ["REFRESH_NUMBERS_TEST_MISSING_KEY"] }),
      n("sdk_tests", "164", { command: "echo 170" }),
    ],
  });
  const r = run(root, config, ["--refresh"], { REFRESH_NUMBERS_TEST_MISSING_KEY: undefined });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /graph_receipts/);
  assert.match(r.out, /REFRESH_NUMBERS_TEST_MISSING_KEY/);
  assert.equal(
    readFileSync(join(root, "README.md"), "utf8"),
    "<!-- n:graph_receipts -->259<!-- /n --> / <!-- n:sdk_tests -->170<!-- /n -->\n",
  );
});

test("--refresh: コマンドが非 0 か空出力なら exit 1 で何も書かない（fail-loud）", () => {
  const doc = "<!-- n:sdk_tests -->164<!-- /n -->\n";
  const { root, config } = fixture({
    docs: { "README.md": doc },
    numbers: [n("sdk_tests", "164", { command: "false" })],
  });
  const before = readFileSync(config, "utf8");
  const r = run(root, config, ["--refresh"]);
  assert.equal(r.code, 1, r.out);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), doc);
  assert.equal(readFileSync(config, "utf8"), before);
});

// ---- コードフェンスの中 ----
// GitHub はフェンス内の HTML コメントをそのまま表示する（2026-09-07 に POST /markdown で実測）。
// だから ```bash の中の `# 697 commits` や出力の `ℹ tests 164` には印を置けない。
// そこは JSON 側で `literal: [{ doc, pattern }]`（(?<v>...) 名前付きグループが値）で結ぶ。

test("(g) literal: フェンス内の数字を pattern で突き合わせ、不一致なら exit 1・一致なら exit 0", () => {
  const doc = "```\nℹ tests 164\nℹ pass 164\n```\n";
  const lit = { doc: "SKILL.md", pattern: "^ℹ (?:tests|pass) (?<v>\\d+)$" };
  const bad = fixture({ docs: { "SKILL.md": doc }, numbers: [n("sdk_tests", "165", { literal: [lit] })] });
  const r1 = run(bad.root, bad.config, ["--check"]);
  assert.equal(r1.code, 1, r1.out);
  assert.match(r1.out, /sdk_tests/);
  assert.match(r1.out, /SKILL\.md/);
  const good = fixture({ docs: { "SKILL.md": doc }, numbers: [n("sdk_tests", "164", { literal: [lit] })] });
  assert.equal(run(good.root, good.config, ["--check"]).code, 0);
});

test("(g2) literal: pattern がどこにも当たらない id は exit 1（印の無い id と同じ扱い）", () => {
  const { root, config } = fixture({
    docs: { "SKILL.md": "```\nℹ tests 164\n```\n" },
    numbers: [n("sdk_tests", "164", { literal: [{ doc: "SKILL.md", pattern: "^ℹ nothing (?<v>\\d+)$" }] })],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sdk_tests/);
});

test("(g3) --refresh は literal の値グループだけを書き換える（同じ行の他の数字は触らない）", () => {
  const doc = "```bash\ngit rev-list --count HEAD   # 697 commits (2026-09-06)\n```\n";
  const { root, config } = fixture({
    docs: { "AI_USAGE.md": doc },
    numbers: [
      n("total_commits", "697", { command: "echo 743", literal: [{ doc: "AI_USAGE.md", pattern: "# (?<v>\\d+) commits \\(" }] }),
    ],
  });
  const r = run(root, config, ["--refresh"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(
    readFileSync(join(root, "AI_USAGE.md"), "utf8"),
    "```bash\ngit rev-list --count HEAD   # 743 commits (2026-09-06)\n```\n",
  );
  assert.equal(run(root, config, ["--check"]).code, 0);
});

test("(h) --check: <!-- n: --> の印がコードフェンスの中にあれば exit 1（レンダリングに出てしまう）", () => {
  const { root, config } = fixture({
    docs: { "README.md": "```bash\ngit x   # <!-- n:sdk_tests -->164<!-- /n --> commits\n```\n" },
    numbers: [n("sdk_tests", "164")],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fence|フェンス/);
  assert.match(r.out, /sdk_tests/);
});

test("(g4) literal: 同じ id の複数 pattern のうち1つでも当たらなければ exit 1", () => {
  const { root, config } = fixture({
    docs: { "SKILL.md": "```\nℹ tests 164\n```\n" },
    numbers: [
      n("sdk_tests", "164", {
        literal: [
          { doc: "SKILL.md", pattern: "^ℹ tests (?<v>\\d+)$" },
          { doc: "SKILL.md", pattern: "^ℹ pass (?<v>\\d+)$" },
        ],
      }),
    ],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ℹ pass/);
});
