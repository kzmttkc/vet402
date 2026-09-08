#!/usr/bin/env node
// ============================================================
// docs/ethonline-2026/COMMITS_EN.md — an English index of every commit in the
// ETHOnline 2026 window, derived from `git log pre-ethonline-2026..<ref>`.
//
//   node scripts/ethonline-commits-en.mjs            # regenerate the file (exit 1 if a subject is untranslated)
//   node scripts/ethonline-commits-en.mjs --check    # write nothing; exit 1 if any Japanese subject has no
//                                                    # translation, or a translation's recorded original no
//                                                    # longer matches the commit (stale entry)
//   node scripts/ethonline-commits-en.mjs --ref origin/main   # derive from another ref (default HEAD)
//
// Why a script and not a hand-written list: every hand-maintained number in this
// window went stale within a day (CHANGED_FILES.md, 2026-09-05). Commit subjects
// before 20:00 JST on 2026-09-08 are Japanese (GIT_RULES.md); judges read English.
// History is not rewritten, so the English lives beside the log, keyed by SHA:
//   docs/ethonline-2026/commit-titles-en.json  { titles: { "<40-hex sha>": { ja, en } } }
// A subject with no CJK characters is English already and is printed as is. A
// Japanese subject with no entry is printed as [untranslated] and the run exits 1,
// so the final pass before the deadline shows every gap. Nothing here reads the
// network or any key.
// ============================================================
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "pre-ethonline-2026";
const HACKING_BEGINS = "2026-09-04T16:00:00Z"; // ETHGlobal schedule, `hacking-begins` (DISCLOSURE_2026-09-05.md)
// The claimed range: README.md §"ETHOnline 2026 (Continuity)". Keep this list identical to README's.
const CLAIM_PATHS = [
  "packages/sdk",
  "packages/mcp-server",
  "examples/ethonline-2026-demo",
  "examples/ethonline-2026-ab",
  "SKILL.md",
  "AI_USAGE.md",
  "docs/ethonline-2026",
];
const TITLES_PATH = join(ROOT, "docs/ethonline-2026/commit-titles-en.json");
const OUT_PATH = join(ROOT, "docs/ethonline-2026/COMMITS_EN.md");
const CJK = /[぀-ヿ一-鿿！-｠]/;
const UNTRANSLATED = "[untranslated]";

function parseArgs(argv) {
  const a = { check: false, ref: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--check") a.check = true;
    else if (x === "--ref") a.ref = argv[++i] ?? "";
    else if (x === "-h" || x === "--help") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 12).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
    else { console.error(`unknown option: ${x}`); process.exit(2); }
  }
  if (!a.ref) { console.error("--ref needs a value"); process.exit(2); }
  return a;
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim().slice(0, 300)}`);
  return r.stdout;
}

/** Every commit in TAG..ref, oldest first by committer time (UTC). */
function readCommits(ref) {
  const raw = git(["log", "--format=%H%x1f%cI%x1f%P%x1f%s", `${TAG}..${ref}`]);
  const rows = raw.split("\n").filter(Boolean).map((line) => {
    const [sha, cI, parents, subject] = line.split("\x1f");
    return { sha, at: new Date(cI), merge: parents.trim().split(" ").length > 1, subject };
  });
  rows.sort((a, b) => a.at - b.at || a.sha.localeCompare(b.sha));
  return rows;
}

function readClaimed(ref) {
  const raw = git(["rev-list", `${TAG}..${ref}`, "--", ...CLAIM_PATHS]);
  return new Set(raw.split("\n").filter(Boolean));
}

function readTitles() {
  const j = JSON.parse(readFileSync(TITLES_PATH, "utf8"));
  if (!j || typeof j.titles !== "object") throw new Error(`${TITLES_PATH}: expected { titles: { <sha>: { ja, en } } }`);
  return j.titles;
}

const pad = (n) => String(n).padStart(2, "0");
const utcDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcTime = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const utcStamp = (d) => `${utcDay(d)} ${utcTime(d)}:${pad(d.getUTCSeconds())} UTC`;
const cell = (s) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function main() {
  const { check, ref } = parseArgs(process.argv.slice(2));
  const head = git(["rev-parse", ref]).trim();
  const tagAt = new Date(git(["show", "-s", "--format=%cI", `${TAG}^{commit}`]).trim());
  const leadMin = Math.round((new Date(HACKING_BEGINS) - tagAt) / 60000);
  const lead = `${Math.floor(Math.abs(leadMin) / 60)} h ${pad(Math.abs(leadMin) % 60)} min ${leadMin >= 0 ? "before" : "after"}`;
  const shown = ref === "HEAD" ? head.slice(0, 7) : ref; // print a reproducible range, not "HEAD"
  const commits = readCommits(ref);
  const claimed = readClaimed(ref);
  const titles = readTitles();
  const begins = new Date(HACKING_BEGINS);

  const problems = [];
  let translated = 0;
  let english = 0;
  for (const c of commits) {
    if (!CJK.test(c.subject)) { c.en = c.subject; english++; continue; }
    const t = titles[c.sha];
    if (!t || typeof t.en !== "string" || !t.en.trim()) { c.en = UNTRANSLATED; problems.push(`${c.sha.slice(0, 7)} ${UNTRANSLATED}: ${c.subject}`); continue; }
    if (t.ja !== c.subject) problems.push(`${c.sha.slice(0, 7)} stale entry: recorded ja ${JSON.stringify(t.ja)} != commit subject ${JSON.stringify(c.subject)}`);
    if (CJK.test(t.en)) problems.push(`${c.sha.slice(0, 7)} translation still contains CJK: ${t.en}`);
    c.en = t.en;
    translated++;
  }
  const inRange = new Set(commits.map((c) => c.sha));
  const unused = Object.keys(titles).filter((s) => !inRange.has(s));

  const days = new Map();
  for (const c of commits) {
    const d = utcDay(c.at);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(c);
  }
  const claimedCount = commits.filter((c) => claimed.has(c.sha)).length;
  const preWindow = commits.filter((c) => claimed.has(c.sha) && c.at < begins);
  const merges = commits.filter((c) => c.merge).length;

  const lines = [];
  lines.push("# ETHOnline 2026 — every commit in the window, in English");
  lines.push("");
  lines.push("<!-- GENERATED by scripts/ethonline-commits-en.mjs — do not edit by hand; edit commit-titles-en.json and regenerate -->");
  lines.push("");
  lines.push("## How this file is made");
  lines.push("");
  lines.push(`This is \`git log ${TAG}..${shown}\` (${commits.length} commits; \`${shown}\` was \`${ref}\` when generated), grouped by day in UTC and rendered by`);
  lines.push("[`scripts/ethonline-commits-en.mjs`](../../scripts/ethonline-commits-en.mjs) — `node scripts/ethonline-commits-en.mjs` regenerates it,");
  lines.push("`--check` fails if any Japanese subject lacks a translation. `main` is also this product's production branch, so the window contains");
  lines.push("work we do **not** submit; the **Claimed** column is derived from the path filter in `README.md`:");
  lines.push("");
  lines.push("```bash");
  lines.push(`git log ${TAG}..${shown} -- ${CLAIM_PATHS.slice(0, 2).join(" ")} \\`);
  lines.push(`    ${CLAIM_PATHS.slice(2, 4).join(" ")} \\`);
  lines.push(`    ${CLAIM_PATHS.slice(4).join(" ")}    # ✔ claimed`);
  lines.push(`git log ${TAG}..${shown}             # everything, ✔ and —`);
  lines.push("```");
  lines.push("");
  lines.push(`A commit is ✔ when it touches at least one of those paths, — otherwise. Subjects written before the English-subject rule took effect`);
  lines.push(`(20:00 JST on 2026-09-08, [\`GIT_RULES.md\`](./GIT_RULES.md)) are Japanese in the log; their English here is our translation, kept by full SHA in`);
  lines.push(`[\`commit-titles-en.json\`](./commit-titles-en.json) next to the original (\`git show -s --format=%s <sha>\` is the original). History is not rewritten.`);
  lines.push(`Hacking began at ${HACKING_BEGINS.replace("T", " ").replace("Z", " UTC")}; the boundary tag points at \`${TAG}\` = ${utcStamp(tagAt)}, ${lead} that, and the claimed commits made before`);
  lines.push(`that instant are marked **⚠ pre-window** below and listed in [\`DISCLOSURE_2026-09-05.md\`](./DISCLOSURE_2026-09-05.md).`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Generated | ${utcStamp(new Date())} from \`${head}\` |`);
  lines.push(`| Range | \`${TAG}..${shown}\` — **${commits.length} commits** on ${days.size} days (UTC), ${merges} of them merges |`);
  lines.push(`| Claimed (✔) | **${claimedCount}** — touch at least one path in the filter |`);
  lines.push(`| Not claimed (—) | **${commits.length - claimedCount}** — production work in the same days |`);
  lines.push(`| Claimed but before ${HACKING_BEGINS.replace("T", " ").replace("Z", " UTC")} | **${preWindow.length}** (⚠) |`);
  lines.push(`| Subjects translated from Japanese | **${translated}** (English already: ${english}${problems.length ? `; untranslated: ${problems.filter((p) => p.includes(UNTRANSLATED)).length}` : ""}) |`);
  lines.push("");
  lines.push("## By day (UTC), oldest first");
  lines.push("");
  for (const [day, list] of days) {
    const c = list.filter((x) => claimed.has(x.sha)).length;
    lines.push(`### ${day} — ${list.length} commits, ${c} claimed`);
    lines.push("");
    lines.push("| SHA | UTC | Claimed | Subject (English) |");
    lines.push("|---|---|:---:|---|");
    for (const x of list) {
      const flag = claimed.has(x.sha) ? (x.at < begins ? "✔ ⚠ pre-window" : "✔") : "—";
      const sha = `[\`${x.sha.slice(0, 7)}\`](https://github.com/kzmttkc/vet402/commit/${x.sha})`;
      const subj = x.merge && !CJK.test(x.subject) ? `*${cell(x.en)}*` : cell(x.en);
      lines.push(`| ${sha} | ${utcTime(x.at)} | ${flag} | ${subj} |`);
    }
    lines.push("");
  }
  const md = lines.join("\n");

  for (const p of problems) console.error(`ethonline-commits-en: ${p}`);
  for (const s of unused) console.error(`ethonline-commits-en: note: translation for ${s.slice(0, 7)} is not in ${TAG}..${ref} (unused)`);

  if (!check) {
    writeFileSync(OUT_PATH, md);
    console.log(`wrote ${OUT_PATH}`);
  }
  console.log(`ethonline-commits-en: ${commits.length} commits (${claimedCount} claimed, ${preWindow.length} claimed pre-window), ${translated} translated, ${english} English, ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error(`ethonline-commits-en: ${e.message}`);
  process.exit(1);
}
