#!/usr/bin/env node
// ============================================================
// 提出物の文書に載る「動く数字」を1コマンドで再計算し、古ければ CI で赤にする。
// 2026-09-07 Takeshi 採用（「提出直前に数字だけ拾って変える」を1コマンドに）。
//
//   node scripts/refresh-numbers.mjs --check               # CI: derive は導出して文書と比べ、recorded は印の値 == 記録値か
//   node scripts/refresh-numbers.mjs --refresh             # 全コマンドを実走 → 記録値と文書の印を書き換える
//   node scripts/refresh-numbers.mjs --refresh --dry-run   # 差分だけ表示、何も書かない
//
// 印の形（Markdown を壊さず、レンダリングにも出ない）:   <!-- n:sdk_tests -->164<!-- /n -->
// 定義と記録値は scripts/refresh-numbers.json の1ファイル:
//   { "docs": [...], "numbers": [{ id, description, check, command, env?, literal?, value, updatedAt }] }
//
// check（必須・2026-09-07 Takeshi 採用）:
//   "derive"   git だけで安く出る数字（コミット数・会期のファイル数）。--check でも command を実走し、
//              文書の値と**導出値**を比べる。記録値（value）は参考にしかならず、--check では書き換えない。
//              関門に正解の写しを持たせると、HEAD が進んで写しも文書も古くなったとき緑のまま通る。
//              だから安く導出できるものは導出で比べる。CI 側は shallow clone だと数えられない
//              （depth 1 では rev-list が 1、タグ pre-ethonline-2026 も無い）ので checkout は fetch-depth: 0。
//              導出は id=as_of の基準時刻に固定する（下）。「今の HEAD」で導出すると文書を含むコミット自身が
//              数に入り、コミットを積むたびに赤になった（f31bc07 直後に 754≠755）。
//   "recorded" 実行に時間か鍵が要る数字（npm test は build 込みで数十秒、The Graph 系は鍵）。
//              --check は「文書の印の値 == JSON の記録値」だけを見る。
//   check の無い id・上のどちらでもない値は --check / --refresh とも exit 1（黙って recorded 扱いにしない）。
//
// 基準時刻 id=as_of（recorded・2026-09-07）:
//   value = 文書に出る日付（JST・command は TZ=Asia/Tokyo date +%F）、end = --refresh を打った瞬間（+09:00・秒精度）。
//   derive の command は {{AS_OF_END}}（= end）と {{AS_OF_SHA}}（= git rev-list -1 --until='<end>' HEAD）を使える。
//     git rev-list --count --until='{{AS_OF_END}}' HEAD
//     git diff --diff-filter=A --name-only pre-ethonline-2026..{{AS_OF_SHA}} | wc -l
//   --check は同じ end で導出するので、同じ as_of の間は HEAD が進んでも値が変わらない。
//   --refresh は as_of（value・end）を今に更新してから derive を取り直す。
//   end を「as_of の 23:59:59」にしない: 同じ日に積んだコミットが全部 --until に入り、赤が再発する。
//   as_of が未来／value と end の日付が食い違う／end 以前にコミットが無い（AS_OF_SHA が空）／
//   {{…}} を使うのに as_of や end が無い、はどれも exit 1（黙って全部数えない）。
//   --until は committer date を見る。rebase はそれを書き換えるので、refresh は fetch + rebase の後に打つ。
//
// コードフェンス（```）の中には印を置けない——GitHub はフェンス内の HTML コメントをそのまま表示する
// （2026-09-07 に POST /markdown で実測）。```bash の `# 697 commits` や出力の `ℹ tests 164` は
// JSON 側の literal: [{ doc, pattern }] で結ぶ。pattern は (?<v>...) の名前付きグループが値。
// --check はフェンス内に <!-- n: --> があれば赤にする。
//
// なぜ recorded の --check はコマンドを実走しないか:
//   SDK / MCP のテスト本数は `npm test`（build 込みで数十秒）を回さないと出ず、The Graph 系は鍵が要る。
//   CI の test ジョブは鍵を持たないし、鍵付きの id だけ検査から抜けると「緑だが未検査」が生まれる。
//   記録値を更新できるのは --refresh だけなので、印だけ手で直した／JSON だけ直した／
//   新しい印を足したが定義が無い、のどれも赤になる。古さは refresh を打った人が背負う（updatedAt が残る）。
// ============================================================
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = /<!-- n:([A-Za-z0-9_]+) -->([^<]*)<!-- \/n -->/g;
const CHECK_MODES = new Set(["derive", "recorded"]);
const AS_OF_ID = "as_of";
const PLACEHOLDER = /\{\{(AS_OF_END|AS_OF_SHA)\}\}/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const JST = "Asia/Tokyo";
function jstParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: JST, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return Object.fromEntries(f.formatToParts(d).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}
/** YYYY-MM-DD（JST） */
function jstDate(d) {
  const g = jstParts(d);
  return `${g.year}-${g.month}-${g.day}`;
}
/** YYYY-MM-DDTHH:MM:SS+09:00（秒精度・git の --until がそのまま読める） */
function jstInstant(d) {
  const g = jstParts(d);
  return `${g.year}-${g.month}-${g.day}T${g.hour}:${g.minute}:${g.second}+09:00`;
}

function usesPlaceholder(numbers, name) {
  return numbers.some((n) => typeof n.command === "string" && n.command.includes(`{{${name}}}`));
}

/**
 * 基準時刻を確定する: { end, sha }。sha は {{AS_OF_SHA}} を使う command があるときだけ引く。
 * 検証に落ちたら throw（--check / --refresh とも exit 1）。
 */
function resolveAsOf(root, numbers, now) {
  const needEnd = usesPlaceholder(numbers, "AS_OF_END") || usesPlaceholder(numbers, "AS_OF_SHA");
  const needSha = usesPlaceholder(numbers, "AS_OF_SHA");
  const a = numbers.find((n) => n.id === AS_OF_ID);
  if (!a) {
    if (needEnd) throw new Error(`a command uses {{AS_OF_END}} / {{AS_OF_SHA}} but there is no id=${AS_OF_ID} in the JSON`);
    return null;
  }
  if (!DATE_RE.test(String(a.value))) throw new Error(`id=${AS_OF_ID}: value must be YYYY-MM-DD (got ${JSON.stringify(a.value)})`);
  if (!a.end) {
    if (needEnd) throw new Error(`id=${AS_OF_ID}: needs "end" (the instant --refresh ran, e.g. ${a.value}T12:00:00+09:00) — run --refresh`);
    return null;
  }
  const endDate = new Date(a.end);
  if (Number.isNaN(endDate.getTime())) throw new Error(`id=${AS_OF_ID}: end is not a date: ${JSON.stringify(a.end)}`);
  if (endDate.getTime() > now.getTime()) throw new Error(`id=${AS_OF_ID}: ${a.value} (end ${a.end}) is in the future — --until would silently count everything`);
  if (jstDate(endDate) !== a.value) throw new Error(`id=${AS_OF_ID}: value ${a.value} and end ${a.end} (JST ${jstDate(endDate)}) disagree — run --refresh`);
  let sha = null;
  if (needSha) {
    const r = spawnSync("git", ["rev-list", "-1", `--until=${a.end}`, "HEAD"], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`id=${AS_OF_ID}: git rev-list -1 --until='${a.end}' HEAD failed: ${(r.stderr || "").trim().slice(0, 300)}`);
    sha = (r.stdout ?? "").trim();
    if (!sha) throw new Error(`id=${AS_OF_ID}: {{AS_OF_SHA}} is empty — no commit at or before ${a.end}`);
  }
  return { end: a.end, sha };
}

function expand(command, asOf) {
  return command.replace(PLACEHOLDER, (_, name) => {
    if (!asOf) throw new Error(`{{${name}}} used but no as_of resolved`);
    return name === "AS_OF_END" ? asOf.end : asOf.sha;
  });
}

function parseArgs(argv) {
  const a = { check: false, refresh: false, dryRun: false, root: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--check") a.check = true;
    else if (x === "--refresh") a.refresh = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--root") a.root = argv[++i];
    else if (x === "--config") a.config = argv[++i];
    else {
      console.error(`unknown argument: ${x}`);
      process.exit(2);
    }
  }
  if (a.check === a.refresh) {
    console.error("usage: refresh-numbers.mjs (--check | --refresh [--dry-run]) [--root DIR] [--config FILE]");
    process.exit(2);
  }
  return a;
}

function loadConfig(path) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(cfg.docs) || !Array.isArray(cfg.numbers)) {
    throw new Error(`${path}: expected { docs: [], numbers: [] }`);
  }
  const seen = new Set();
  for (const n of cfg.numbers) {
    if (!n.id || !n.command) throw new Error(`${path}: every number needs id and command (${JSON.stringify(n)})`);
    if (!CHECK_MODES.has(n.check)) {
      throw new Error(`${path}: id=${n.id} needs check: "derive" | "recorded" (got ${JSON.stringify(n.check ?? null)}) — a missing check is not silently treated as recorded`);
    }
    if (seen.has(n.id)) throw new Error(`${path}: duplicate id ${n.id}`);
    seen.add(n.id);
  }
  return cfg;
}

function readDoc(root, doc) {
  const p = join(root, doc);
  if (!existsSync(p)) throw new Error(`doc not found: ${doc}`);
  return readFileSync(p, "utf8");
}

/** ``` で囲まれた範囲 [start, end) を返す（閉じていなければ末尾まで） */
function fenceRanges(body) {
  const ranges = [];
  const re = /^(```|~~~)/gm;
  let open = null;
  for (const m of body.matchAll(re)) {
    if (open === null) open = m.index;
    else {
      ranges.push([open, m.index + m[0].length]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open, body.length]);
  return ranges;
}

/** 文書ごとに印を集める: [{ doc, id, value, inFence }] */
function collectMarks(root, docs) {
  const marks = [];
  for (const doc of docs) {
    const body = readDoc(root, doc);
    const fences = fenceRanges(body);
    for (const m of body.matchAll(MARK)) {
      const inFence = fences.some(([a, b]) => m.index >= a && m.index < b);
      marks.push({ doc, id: m[1], value: m[2], inFence });
    }
  }
  return marks;
}

function literalRegex(lit) {
  const re = new RegExp(lit.pattern, "gmd");
  if (!lit.pattern.includes("(?<v>")) throw new Error(`literal pattern for ${lit.doc} needs a (?<v>...) group: ${lit.pattern}`);
  return re;
}

/** literal の突き合わせ結果: [{ doc, id, value }]（当たりが無ければ空） */
function collectLiterals(root, numbers) {
  const hits = [];
  for (const n of numbers) {
    for (const lit of n.literal ?? []) {
      const body = readDoc(root, lit.doc);
      for (const m of body.matchAll(literalRegex(lit))) hits.push({ doc: lit.doc, id: n.id, value: m.groups.v, inFence: false, pattern: lit.pattern });
    }
  }
  return hits;
}

/** literal の値グループだけを差し替える */
function applyLiterals(body, lit, value) {
  const re = literalRegex(lit);
  let out = "";
  let last = 0;
  for (const m of body.matchAll(re)) {
    const [a, b] = m.indices.groups.v;
    out += body.slice(last, a) + value;
    last = b;
  }
  return out + body.slice(last);
}

function check(root, cfg) {
  const marks = [...collectMarks(root, cfg.docs), ...collectLiterals(root, cfg.numbers)];
  const byId = new Map(cfg.numbers.map((n) => [n.id, n]));
  const problems = [];

  // 基準時刻（as_of）が壊れていれば導出せずに赤
  let asOf;
  try {
    asOf = resolveAsOf(root, cfg.numbers, new Date());
  } catch (e) {
    console.log(`✖ ${e.message}`);
    return 1;
  }

  // derive: 記録値は見ない。as_of に固定して今ここで導出した値が「正」で、文書がそれと違えば赤（記録値は書かない）。
  const derived = new Map();
  for (const n of cfg.numbers) {
    if (n.check !== "derive") continue;
    const r = runCommand(root, expand(n.command, asOf));
    if (r.error) problems.push(`id=${n.id}: derive command failed — ${n.command}\n    ${r.error}`);
    else derived.set(n.id, r.value);
  }

  for (const m of marks) {
    const n = byId.get(m.id);
    if (m.inFence) {
      problems.push(`${m.doc}: mark n:${m.id} sits inside a code fence — GitHub renders it literally; use "literal" in the JSON instead`);
    } else if (!n) {
      problems.push(`${m.doc}: mark n:${m.id} is not defined in the JSON (value "${m.value}")`);
    } else if (n.check === "derive") {
      if (!derived.has(m.id)) continue; // command failed: already reported once above
      if (derived.get(m.id) !== m.value) problems.push(`${m.doc}: id=${m.id} doc="${m.value}" derived="${derived.get(m.id)}" (${n.command})`);
    } else if (n.value === null || n.value === undefined) {
      problems.push(`${m.doc}: id=${m.id} has no recorded value yet — run --refresh`);
    } else if (String(n.value) !== m.value) {
      problems.push(`${m.doc}: id=${m.id} doc="${m.value}" recorded="${n.value}" (updatedAt ${n.updatedAt})`);
    }
  }
  const marked = new Set(marks.map((m) => m.id));
  for (const n of cfg.numbers) {
    if (!marked.has(n.id)) problems.push(`id=${n.id} has no <!-- n:${n.id} --> mark and no literal hit in any doc (${cfg.docs.join(", ")})`);
    for (const lit of n.literal ?? []) {
      if (!marks.some((m) => m.id === n.id && m.doc === lit.doc && m.pattern === lit.pattern)) problems.push(`${lit.doc}: literal pattern for id=${n.id} matched nothing: ${lit.pattern}`);
    }
  }

  if (problems.length) {
    for (const p of problems) console.log(`✖ ${p}`);
    console.log(`\n${problems.length} problem(s). Run: node scripts/refresh-numbers.mjs --refresh`);
    return 1;
  }
  const nDerive = cfg.numbers.filter((n) => n.check === "derive").length;
  console.log(`✔ ${cfg.numbers.length} number(s) consistent across ${cfg.docs.length} doc(s), ${marks.length} mark(s) — ${nDerive} derived now, ${cfg.numbers.length - nDerive} against recorded values`);
  return 0;
}

function runCommand(root, command) {
  const r = spawnSync("sh", ["-c", command], { cwd: root, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { error: `exit ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}` };
  const value = (r.stdout ?? "").trim();
  if (value === "") return { error: "empty output" };
  return { value };
}

function refresh(root, cfg, configPath, dryRun) {
  const marksBefore = [...collectMarks(root, cfg.docs), ...collectLiterals(root, cfg.numbers)];
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const rows = [];
  let failed = false;

  // 基準時刻を先に今へ動かす（value = 今日 JST、end = この瞬間）。dry-run では cfg に書かず、導出にだけ使う。
  const a = cfg.numbers.find((n) => n.id === AS_OF_ID);
  let asOf = null;
  if (a) {
    const r = runCommand(root, a.command);
    if (r.error) {
      console.log(`✖ ${a.id}: ${a.command}\n    ${r.error}\n\n✖ a command failed — nothing written`);
      return 1;
    }
    const end = jstInstant(nowDate);
    if (r.value !== jstDate(nowDate)) {
      console.log(`✖ ${a.id}: command printed ${JSON.stringify(r.value)} but today (JST) is ${jstDate(nowDate)} — nothing written`);
      return 1;
    }
    const changed = String(a.value) !== r.value || a.end !== end;
    rows.push({ id: a.id, before: a.end ? `${a.value} (end ${a.end})` : a.value, after: `${r.value} (end ${end})`, status: changed ? "changed" : "same" });
    if (!dryRun) {
      a.value = r.value;
      a.end = end;
      a.updatedAt = now;
    }
    try {
      asOf = resolveAsOf(root, cfg.numbers.map((n) => (n === a ? { ...a, value: r.value, end } : n)), nowDate);
    } catch (e) {
      console.log(`✖ ${e.message}\n\n✖ nothing written`);
      return 1;
    }
  } else {
    try {
      asOf = resolveAsOf(root, cfg.numbers, nowDate);
    } catch (e) {
      console.log(`✖ ${e.message}\n\n✖ nothing written`);
      return 1;
    }
  }

  for (const n of cfg.numbers) {
    if (n === a) continue;
    const missing = (n.env ?? []).filter((k) => !process.env[k]);
    if (missing.length) {
      console.log(`⚠ ${n.id}: skipped — env ${missing.join(", ")} not set (keeping "${n.value}")`);
      rows.push({ id: n.id, before: n.value, after: n.value, status: "skipped" });
      continue;
    }
    const r = runCommand(root, expand(n.command, asOf));
    if (r.error) {
      console.log(`✖ ${n.id}: ${n.command}\n    ${r.error}`);
      failed = true;
      rows.push({ id: n.id, before: n.value, after: null, status: "error" });
      continue;
    }
    const changed = String(n.value) !== r.value;
    rows.push({ id: n.id, before: n.value, after: r.value, status: changed ? "changed" : "same" });
    if (!dryRun) {
      n.value = r.value;
      n.updatedAt = now;
    }
  }

  const docsOf = (id) => [...new Set(marksBefore.filter((m) => m.id === id).map((m) => m.doc))].join(", ") || "(no mark)";
  console.log(`\n${dryRun ? "DRY RUN — " : ""}${rows.length} id(s):`);
  for (const r of rows) {
    const arrow = r.status === "changed" ? `${r.before} → ${r.after}` : r.status === "same" ? `${r.after} (same)` : `${r.before} (${r.status})`;
    console.log(`  ${r.status.padEnd(7)} ${r.id.padEnd(24)} ${arrow.padEnd(24)} ${docsOf(r.id)}`);
  }

  if (failed) {
    console.log("\n✖ a command failed — nothing written");
    return 1;
  }
  if (dryRun) return 0;

  // 記録値 → JSON、印 → 文書
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  const byId = new Map(cfg.numbers.map((n) => [n.id, n]));
  let rewritten = 0;
  for (const doc of cfg.docs) {
    const p = join(root, doc);
    const before = readFileSync(p, "utf8");
    let after = before.replace(MARK, (whole, id) => {
      const n = byId.get(id);
      if (!n || n.value === null || n.value === undefined) return whole;
      return `<!-- n:${id} -->${n.value}<!-- /n -->`;
    });
    for (const n of cfg.numbers) {
      if (n.value === null || n.value === undefined) continue;
      for (const lit of n.literal ?? []) if (lit.doc === doc) after = applyLiterals(after, lit, String(n.value));
    }
    if (after !== before) {
      writeFileSync(p, after);
      rewritten++;
    }
  }
  console.log(`\n✔ recorded values written to ${configPath}; ${rewritten} doc(s) rewritten`);
  return check(root, cfg);
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const configPath = resolve(args.config ?? join(root, "scripts", "refresh-numbers.json"));
let cfg;
try {
  cfg = loadConfig(configPath);
} catch (e) {
  console.log(`✖ ${e.message}`);
  process.exit(1);
}
process.exit(args.check ? check(root, cfg) : refresh(root, cfg, configPath, args.dryRun));
