// ============================================================
// scripts/refresh-numbers.mjs（2026-09-07 Takeshi 採用「提出直前に数字だけ拾って変える」を1コマンドに）。
//
// 提出物の文書に載る動く数字（テスト本数・会期のファイル数など）を
// `<!-- n:ID -->164<!-- /n -->` で囲み、`--refresh` がコマンドで再計算して書き換え、
// `--check` が「印の値 == scripts/refresh-numbers.json の記録値」を CI で見張る。
//
// 各 id は check: "derive" | "recorded" を持つ（2026-09-07 Takeshi 採用）。
//   derive   … git だけで安く出る数字。--check でもコマンドを実走し、文書の値と直接比べる（記録値は書かない）
//   recorded … 実行に時間か鍵が要る数字（npm test・The Graph）。--check は「印の値 == 記録値」だけを見る
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
  check?: "derive" | "recorded" | string;
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
  check: "recorded",
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

// ---- check: "derive" | "recorded" ----
// git で安く出る数字（コミット数・ファイル数）は記録値に頼らず、--check の場で導出して文書と比べる。
// 記録値を写しておく方式だと「HEAD が進んだのに記録値も文書も古い」が緑のまま通る
// （関門に正解の写しを持たせない・導出を持たせる）。

test("(i) derive: 記録値が古くても、導出値が文書と一致すれば exit 0", () => {
  const { root, config } = fixture({
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->164<!-- /n -->\n" },
    numbers: [n("total_commits", "100", { check: "derive", command: "echo 164" })],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 0, r.out);
});

test("(j) derive: 導出値と文書が違えば exit 1・文書の値と導出値の両方を印字", () => {
  const { root, config } = fixture({
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->164<!-- /n -->\n" },
    numbers: [n("total_commits", "164", { check: "derive", command: "echo 170" })],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /total_commits/);
  assert.match(r.out, /AI_USAGE\.md/);
  assert.match(r.out, /164/, "文書の値");
  assert.match(r.out, /170/, "導出値");
});

test("(k) derive: --check は記録値を書き換えない（read-only）", () => {
  const { root, config } = fixture({
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->164<!-- /n -->\n" },
    numbers: [n("total_commits", "100", { check: "derive", command: "echo 164" })],
  });
  const before = readFileSync(config, "utf8");
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(config, "utf8"), before);
});

test("(l) derive: literal（フェンス内）も導出値と直接比べる", () => {
  const doc = "```bash\ngit rev-list --count HEAD   # 164 commits (2026-09-06)\n```\n";
  const lit = { doc: "AI_USAGE.md", pattern: "# (?<v>\\d+) commits \\(" };
  const good = fixture({ docs: { "AI_USAGE.md": doc }, numbers: [n("total_commits", "100", { check: "derive", command: "echo 164", literal: [lit] })] });
  assert.equal(run(good.root, good.config, ["--check"]).code, 0);
  const bad = fixture({ docs: { "AI_USAGE.md": doc }, numbers: [n("total_commits", "164", { check: "derive", command: "echo 170", literal: [lit] })] });
  const r = run(bad.root, bad.config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /170/);
});

test("(m) derive: --check でコマンドが失敗したら exit 1（黙って記録値に落ちない）", () => {
  const { root, config } = fixture({
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->164<!-- /n -->\n" },
    numbers: [n("total_commits", "164", { check: "derive", command: "false" })],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /total_commits/);
});

test("(n) recorded: --check はコマンドを実走せず、印の値 == 記録値だけを見る", () => {
  const { root, config } = fixture({
    docs: { "SKILL.md": "tests <!-- n:sdk_tests -->164<!-- /n -->\n" },
    numbers: [n("sdk_tests", "164", { check: "recorded", command: "echo 999" })],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /999/);
});

test("(o) check の無い id は exit 1（黙って recorded 扱いにしない）", () => {
  const { root, config } = fixture({
    docs: { "SKILL.md": "tests <!-- n:sdk_tests -->164<!-- /n -->\n" },
    numbers: [{ id: "sdk_tests", description: "x", command: "echo 164", value: "164", updatedAt: "2026-09-07T00:00:00.000Z" }],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sdk_tests/);
  assert.match(r.out, /check/);
});

test("(o2) check が derive / recorded 以外なら exit 1", () => {
  const { root, config } = fixture({
    docs: { "SKILL.md": "tests <!-- n:sdk_tests -->164<!-- /n -->\n" },
    numbers: [n("sdk_tests", "164", { check: "cached" })],
  });
  const r = run(root, config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sdk_tests/);
  assert.match(r.out, /cached/);
});

// ---- as_of に固定した導出（2026-09-07）----
// derive を「今の HEAD」で導出すると、文書を含むコミット自身が数に入り、コミットを積むたびに --check が赤になる
// （f31bc07 直後に 754≠755。前担当は refresh → commit → refresh → amend で逃げていたが、他セッションや会期後には成り立たない）。
// 基準は JSON の id=as_of: value が日付（文書に出る）、end が --refresh を打った瞬間（+09:00）。
// derive の command は {{AS_OF_END}}（= end）と {{AS_OF_SHA}}（= git rev-list -1 --until='<end>' HEAD）を使える。
// end を「as_of の 23:59:59」にすると、同じ日に積んだコミットが全部入って赤が再発する——だから瞬間を記録する。

function gitFixture(commits: { msg: string; date: string }[], opts: { docs: Record<string, string>; numbers: Num[] }) {
  const { root, config } = fixture(opts);
  const git = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  const commit = (msg: string, date: string) => {
    git(["add", "-A"]);
    git(["commit", "-q", "--allow-empty", "-m", msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git(["rev-parse", "HEAD"]);
  };
  const shas = commits.map((c) => commit(c.msg, c.date));
  return { root, config, git, commit, shas };
}

const asOf = (value: string, end: string): Num => ({
  id: "as_of",
  description: "基準日",
  command: "TZ=Asia/Tokyo date +%F",
  check: "recorded",
  value,
  updatedAt: "2026-09-07T00:00:00.000Z",
  ...({ end } as object),
});

const commitsUntil = (): Num =>
  n("total_commits", "0", { check: "derive", command: "git rev-list --count --until='{{AS_OF_END}}' HEAD" });

test("(p) as_of が固定なら、後からコミットを積んでも derive の値は変わらず --check は緑のまま", () => {
  const f = gitFixture(
    [
      { msg: "c1", date: "2026-09-01T10:00:00+09:00" },
      { msg: "c2", date: "2026-09-02T10:00:00+09:00" },
    ],
    {
      docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->0<!-- /n --> (<!-- n:as_of -->2000-01-01<!-- /n -->)\n" },
      numbers: [asOf("2000-01-01", "2000-01-01T00:00:00+09:00"), commitsUntil()],
    },
  );
  const r = run(f.root, f.config, ["--refresh"]);
  assert.equal(r.code, 0, r.out);
  const doc1 = readFileSync(join(f.root, "AI_USAGE.md"), "utf8");
  assert.match(doc1, /<!-- n:total_commits -->2<!-- \/n -->/, "refresh 直後は 2 コミット");
  assert.equal(run(f.root, f.config, ["--check"]).code, 0);
  // 文書を含むコミット＋その後のコミット。日付は実時刻（未来日付にすると git が --until=今 で除外して偶然緑になる）。
  // end は秒精度なので、end の翌秒まで待ってから積む（同じ秒に積むと --until に含まれる）。
  const end = (JSON.parse(readFileSync(f.config, "utf8")) as { numbers: (Num & { end?: string })[] }).numbers.find((x) => x.id === "as_of")!.end!;
  const target = new Date(end).getTime() + 1000;
  assert.ok(target - Date.now() < 5000, `end must be the instant --refresh ran, not a day boundary (end=${end})`);
  if (Date.now() < target) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, target - Date.now());
  f.git(["commit", "-q", "--allow-empty", "-m", "docs"]);
  f.git(["commit", "-q", "--allow-empty", "-m", "later"]);
  assert.equal(f.git(["rev-list", "--count", "HEAD"]), "4");
  const c = run(f.root, f.config, ["--check"]);
  assert.equal(c.code, 0, c.out);
  assert.equal(readFileSync(join(f.root, "AI_USAGE.md"), "utf8"), doc1, "--check は文書を書き換えない");
});

test("(q) --refresh は as_of（value=今日 JST・end=今の瞬間）を更新してから derive を取り直すので値が動く", () => {
  const f = gitFixture(
    [
      { msg: "c1", date: "2026-09-01T10:00:00+09:00" },
      { msg: "c2", date: "2026-09-02T10:00:00+09:00" },
      { msg: "c3", date: "2026-09-03T10:00:00+09:00" },
    ],
    {
      docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->1<!-- /n --> (<!-- n:as_of -->2026-09-01<!-- /n -->)\n" },
      numbers: [asOf("2026-09-01", "2026-09-01T12:00:00+09:00"), commitsUntil()],
    },
  );
  assert.equal(run(f.root, f.config, ["--check"]).code, 0, "固定した as_of では 1 のまま緑");
  const r = run(f.root, f.config, ["--refresh"]);
  assert.equal(r.code, 0, r.out);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  assert.equal(
    readFileSync(join(f.root, "AI_USAGE.md"), "utf8"),
    `commits <!-- n:total_commits -->3<!-- /n --> (<!-- n:as_of -->${today}<!-- /n -->)\n`,
  );
  const json = JSON.parse(readFileSync(f.config, "utf8")) as { numbers: (Num & { end?: string })[] };
  const a = json.numbers.find((x) => x.id === "as_of")!;
  assert.equal(a.value, today);
  assert.match(a.end ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/, "end は +09:00 の瞬間");
  assert.ok(new Date(a.end!).getTime() <= Date.now() + 1000, "end は未来でない");
  assert.equal(run(f.root, f.config, ["--check"]).code, 0);
});

test("(q2) --refresh --dry-run は as_of も end も書かない", () => {
  const f = gitFixture([{ msg: "c1", date: "2026-09-01T10:00:00+09:00" }], {
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->1<!-- /n --> (<!-- n:as_of -->2026-09-01<!-- /n -->)\n" },
    numbers: [asOf("2026-09-01", "2026-09-01T12:00:00+09:00"), commitsUntil()],
  });
  const before = readFileSync(f.config, "utf8");
  const r = run(f.root, f.config, ["--refresh", "--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(f.config, "utf8"), before);
});

test("(r) {{AS_OF_SHA}} は end 以前の最後のコミット（end ちょうどを含み、1 秒後を含まない）", () => {
  const f = gitFixture(
    [
      { msg: "c0", date: "2026-08-31T10:00:00+09:00" },
      { msg: "c1", date: "2026-09-01T23:59:59+09:00" },
      { msg: "c2", date: "2026-09-02T00:00:00+09:00" },
    ],
    {
      docs: { "AI_USAGE.md": "anchor <!-- n:anchor -->c1<!-- /n --> count <!-- n:total_commits -->2<!-- /n --> (<!-- n:as_of -->2026-09-01<!-- /n -->)\n" },
      numbers: [
        asOf("2026-09-01", "2026-09-01T23:59:59+09:00"),
        n("anchor", "x", { check: "derive", command: "git log -1 --format=%s {{AS_OF_SHA}}" }),
        commitsUntil(),
      ],
    },
  );
  const ok = run(f.root, f.config, ["--check"]);
  assert.equal(ok.code, 0, ok.out);
  writeFileSync(join(f.root, "AI_USAGE.md"), "anchor <!-- n:anchor -->c2<!-- /n --> count <!-- n:total_commits -->2<!-- /n --> (<!-- n:as_of -->2026-09-01<!-- /n -->)\n");
  const bad = run(f.root, f.config, ["--check"]);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /anchor/);
  assert.match(bad.out, /derived="c1"/);
});

test("(r2) {{AS_OF_SHA}} は diff の右端にも使える（as_of 時点の HEAD との diff）", () => {
  const f = gitFixture([{ msg: "c0", date: "2026-08-31T10:00:00+09:00" }], {
    docs: { "AI_USAGE.md": "added <!-- n:added -->1<!-- /n --> (<!-- n:as_of -->2026-09-01<!-- /n -->)\n" },
    numbers: [
      asOf("2026-09-01", "2026-09-01T12:00:00+09:00"),
      n("added", "x", { check: "derive", command: "git diff --diff-filter=A --name-only base..{{AS_OF_SHA}} | wc -l | tr -d ' '" }),
    ],
  });
  f.git(["tag", "base"]);
  writeFileSync(join(f.root, "a.txt"), "a\n");
  f.commit("add a", "2026-09-01T11:00:00+09:00");
  writeFileSync(join(f.root, "b.txt"), "b\n");
  f.commit("add b", "2026-09-02T11:00:00+09:00");
  const r = run(f.root, f.config, ["--check"]);
  assert.equal(r.code, 0, r.out);
});

test("(s) as_of が未来（end > 今）なら exit 1（黙って全部数えない）", () => {
  const f = gitFixture([{ msg: "c1", date: "2026-09-01T10:00:00+09:00" }], {
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->1<!-- /n --> (<!-- n:as_of -->2099-01-01<!-- /n -->)\n" },
    numbers: [asOf("2099-01-01", "2099-01-01T00:00:00+09:00"), commitsUntil()],
  });
  const r = run(f.root, f.config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /as_of/);
  assert.match(r.out, /2099-01-01/);
});

test("(s2) end より前にコミットが無ければ {{AS_OF_SHA}} が空 → exit 1", () => {
  const f = gitFixture([{ msg: "c1", date: "2026-09-05T10:00:00+09:00" }], {
    docs: { "AI_USAGE.md": "anchor <!-- n:anchor -->c1<!-- /n --> (<!-- n:as_of -->2026-09-01<!-- /n -->)\n" },
    numbers: [asOf("2026-09-01", "2026-09-01T12:00:00+09:00"), n("anchor", "x", { check: "derive", command: "git log -1 --format=%s {{AS_OF_SHA}}" })],
  });
  const r = run(f.root, f.config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /AS_OF_SHA/);
});

test("(s3) as_of の value（日付）と end（瞬間）の JST 日付が食い違えば exit 1", () => {
  const f = gitFixture([{ msg: "c1", date: "2026-09-01T10:00:00+09:00" }], {
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->1<!-- /n --> (<!-- n:as_of -->2026-09-02<!-- /n -->)\n" },
    numbers: [asOf("2026-09-02", "2026-09-01T12:00:00+09:00"), commitsUntil()],
  });
  const r = run(f.root, f.config, ["--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /as_of/);
});

test("(s4) {{AS_OF_END}} を使う command があるのに id=as_of が無い／end が無いなら exit 1", () => {
  const noAsOf = gitFixture([{ msg: "c1", date: "2026-09-01T10:00:00+09:00" }], {
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->1<!-- /n -->\n" },
    numbers: [commitsUntil()],
  });
  const r1 = run(noAsOf.root, noAsOf.config, ["--check"]);
  assert.equal(r1.code, 1, r1.out);
  assert.match(r1.out, /as_of/);
  const noEnd = gitFixture([{ msg: "c1", date: "2026-09-01T10:00:00+09:00" }], {
    docs: { "AI_USAGE.md": "commits <!-- n:total_commits -->1<!-- /n --> (<!-- n:as_of -->2026-09-01<!-- /n -->)\n" },
    numbers: [n("as_of", "2026-09-01", { command: "TZ=Asia/Tokyo date +%F" }), commitsUntil()],
  });
  const r2 = run(noEnd.root, noEnd.config, ["--check"]);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /end/);
});
