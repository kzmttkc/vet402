#!/usr/bin/env node
// ============================================================
// docs/ethonline-2026/COMMITS_EN.md — an English index of every commit in the
// ETHOnline 2026 window, derived from `git log pre-ethonline-2026..<ref>`.
//
//   node scripts/ethonline-commits-en.mjs            # regenerate the file (exit 1 if a subject is untranslated)
//   node scripts/ethonline-commits-en.mjs --check    # write nothing; exit 1 if any Japanese subject has no
//                                                    # translation, a translation's recorded original no longer
//                                                    # matches the commit (stale entry), or the file is not what
//                                                    # this script produces from the commit it names (hand edit).
//                                                    # A commit after that one that did not regenerate the file
//                                                    # (stale file) is a `note:` on stderr, exit 0
//   node scripts/ethonline-commits-en.mjs --check --strict   # …and a stale file is exit 1 too (the final pass
//                                                    # before the submission Release; run the generator first)
//   node scripts/ethonline-commits-en.mjs --ref origin/main   # derive from another ref (default HEAD)
//   node scripts/ethonline-commits-en.mjs --out <path>        # write/check another path (tests)
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
//
// Freshness (2026-09-09). Until today `--check` only looked at the translations, so
// the file sat three commits behind HEAD and the check stayed green. Now `--check`
// reads the commit the file names in its `Generated` row, renders the index again
// from that commit, and fails if the two differ anywhere but the `Generated` row
// (hand edit, or the generator changed). It then lists the commits after that one:
// each must itself touch this file (i.e. be the commit that regenerated it), or the
// file is stale. Same idea as refresh-numbers --check: derive on the spot, pin the
// derivation to what the document says, never trust a recorded copy.
//
// Two grades (same day, later). The first cut made "stale" exit 1 in root `npm test`,
// so every commit on main had to carry a regenerated COMMITS_EN.md or the branch
// went red — two unrelated branches were blocked within hours. Now:
//   always red   — no Generated row / the SHA is not a commit / not an ancestor of
//                  the ref / the file is not what this script renders from that SHA
//                  (a hand edit or generator drift: the file lies about itself)
//   --strict red — commits after the pinned SHA that did not regenerate the file
//                  (the file is merely behind; a `note:` on stderr by default)
// `npm test` runs the default. The final pass before the submission Release runs
// the generator and then `--check --strict` (RELEASE_NOTES_SUBMISSION.md).
// ============================================================
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
const DEFAULT_OUT = join(ROOT, "docs/ethonline-2026/COMMITS_EN.md");
const CJK = /[぀-ヿ一-鿿！-｠]/;
const UNTRANSLATED = "[untranslated]";
const TOP_PER_DAY = 3;
const GENERATED_ROW = /^\| Generated \| .* from `([0-9a-f]{40})` \|$/m;

function parseArgs(argv) {
  const a = { check: false, strict: false, ref: "HEAD", out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--check") a.check = true;
    else if (x === "--strict") a.strict = true;
    else if (x === "--ref") a.ref = argv[++i] ?? "";
    else if (x === "--out") a.out = resolve(argv[++i] ?? "");
    else if (x === "-h" || x === "--help") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
    else { console.error(`unknown option: ${x}`); process.exit(2); }
  }
  if (!a.ref) { console.error("--ref needs a value"); process.exit(2); }
  if (a.strict && !a.check) { console.error("--strict only means something with --check"); process.exit(2); }
  return a;
}

/** Run git in ROOT. `ok` = exit statuses that are not an error (null: any status; the caller reads .status). */
function git(args, ok = [0]) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (ok !== null && !ok.includes(r.status)) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim().slice(0, 300)}`);
  return { out: r.stdout, status: r.status };
}

/** Every commit in TAG..ref, oldest first by committer time (UTC), with lines changed (merges: 0). */
function readCommits(ref) {
  const raw = git(["log", "--format=%H%x1f%cI%x1f%P%x1f%s", `${TAG}..${ref}`]).out;
  const rows = raw.split("\n").filter(Boolean).map((line) => {
    const [sha, cI, parents, subject] = line.split("\x1f");
    return { sha, at: new Date(cI), merge: parents.trim().split(" ").length > 1, subject, lines: 0 };
  });
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  // --shortstat prints nothing for a merge (no -m), so merges keep lines = 0.
  const stat = git(["log", "--format=%x1e%H", "--shortstat", `${TAG}..${ref}`]).out;
  for (const rec of stat.split("\x1e").filter((s) => s.trim())) {
    const [sha, ...rest] = rec.trim().split("\n");
    const m = /(\d+) insertions?\(\+\)|(\d+) deletions?\(-\)/g;
    let lines = 0;
    for (const line of rest) for (const hit of line.matchAll(m)) lines += Number(hit[1] ?? hit[2] ?? 0);
    const row = bySha.get(sha.trim());
    if (row) row.lines = lines;
  }
  rows.sort((a, b) => a.at - b.at || a.sha.localeCompare(b.sha));
  return rows;
}

function readClaimed(ref) {
  const raw = git(["rev-list", `${TAG}..${ref}`, "--", ...CLAIM_PATHS]).out;
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
const link = (sha) => `[\`${sha.slice(0, 7)}\`](https://github.com/kzmttkc/vet402/commit/${sha})`;

/**
 * Render the index for `head` (a 40-hex sha). Returns { md, problems, unused, stats }.
 * The output depends only on the repository at `head`, commit-titles-en.json, and `generatedAt`
 * (the `Generated` row) — so a check can re-render at the sha the file names and compare.
 */
function render(head, generatedAt) {
  const tagAt = new Date(git(["show", "-s", "--format=%cI", `${TAG}^{commit}`]).out.trim());
  const leadMin = Math.round((new Date(HACKING_BEGINS) - tagAt) / 60000);
  const lead = `${Math.floor(Math.abs(leadMin) / 60)} h ${pad(Math.abs(leadMin) % 60)} min ${leadMin >= 0 ? "before" : "after"}`;
  const shown = head.slice(0, 7);
  const commits = readCommits(head);
  const claimed = readClaimed(head);
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
  const flagOf = (x) => (claimed.has(x.sha) ? (x.at < begins ? "✔ ⚠ pre-window" : "✔") : "—");

  const lines = [];
  lines.push("# ETHOnline 2026 — every commit in the window, in English");
  lines.push("");
  lines.push("<!-- GENERATED by scripts/ethonline-commits-en.mjs — do not edit by hand; edit commit-titles-en.json and regenerate -->");
  lines.push("");
  lines.push("## How this file is made");
  lines.push("");
  lines.push(`This is \`git log ${TAG}..${shown}\` (${commits.length} commits), grouped by day in UTC and rendered by`);
  lines.push("[`scripts/ethonline-commits-en.mjs`](../../scripts/ethonline-commits-en.mjs) — `node scripts/ethonline-commits-en.mjs` regenerates it;");
  lines.push("`--check` (run by `npm test`) fails if any Japanese subject lacks a translation or if this file is not what the script produces from the");
  lines.push("commit named in the **Generated** row; commits after that one which did not regenerate it are a warning, and `--check --strict` (the final pass");
  lines.push("before the submission Release) makes that a failure too. `main` is also this product's production branch, so");
  lines.push("the window contains work we do **not** submit; the **Claimed** column is derived from the path filter in `README.md`:");
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
  lines.push(`| Generated | ${utcStamp(generatedAt)} from \`${head}\` |`);
  lines.push(`| Range | \`${TAG}..${shown}\` — **${commits.length} commits** on ${days.size} days (UTC), ${merges} of them merges |`);
  lines.push(`| Claimed (✔) | **${claimedCount}** — touch at least one path in the filter |`);
  lines.push(`| Not claimed (—) | **${commits.length - claimedCount}** — production work in the same days |`);
  lines.push(`| Claimed but before ${HACKING_BEGINS.replace("T", " ").replace("Z", " UTC")} | **${preWindow.length}** (⚠) |`);
  lines.push(`| Subjects translated from Japanese | **${translated}** (English already: ${english}${problems.length ? `; untranslated: ${problems.filter((p) => p.includes(UNTRANSLATED)).length}` : ""}) |`);
  lines.push("");
  // The short read: what we claim, day by day, with the largest claimed commits of each day.
  // "Largest" = insertions + deletions from `git log --shortstat` (merges count 0, so they never lead).
  lines.push("## Claimed, by day (UTC)");
  lines.push("");
  lines.push(`Per day: how many of the day's commits are ✔, then the ${TOP_PER_DAY} claimed commits with the most lines changed (insertions + deletions;`);
  lines.push("merges count 0). The full table, ✔ and — alike, is folded below.");
  lines.push("");
  for (const [day, list] of days) {
    const c = list.filter((x) => claimed.has(x.sha));
    lines.push(`### ${day} — ${c.length} of ${list.length} claimed`);
    lines.push("");
    if (c.length === 0) { lines.push("- (no claimed commit this day)"); lines.push(""); continue; }
    const top = [...c].sort((a, b) => b.lines - a.lines || a.at - b.at || a.sha.localeCompare(b.sha)).slice(0, TOP_PER_DAY);
    for (const x of top) {
      const pre = x.at < begins ? " ⚠ pre-window" : "";
      lines.push(`- ${link(x.sha)} ${utcTime(x.at)} — ${cell(x.en)} (${x.lines} lines${pre})`);
    }
    lines.push("");
  }
  lines.push("## Every commit, by day (UTC), oldest first");
  lines.push("");
  lines.push("<details>");
  lines.push(`<summary>All ${commits.length} commits — ✔ claimed and — not claimed (click to expand)</summary>`);
  lines.push("");
  for (const [day, list] of days) {
    const c = list.filter((x) => claimed.has(x.sha)).length;
    lines.push(`### ${day} — ${list.length} commits, ${c} claimed`);
    lines.push("");
    lines.push("| SHA | UTC | Claimed | Subject (English) |");
    lines.push("|---|---|:---:|---|");
    for (const x of list) {
      const subj = x.merge && !CJK.test(x.subject) ? `*${cell(x.en)}*` : cell(x.en);
      lines.push(`| ${link(x.sha)} | ${utcTime(x.at)} | ${flagOf(x)} | ${subj} |`);
    }
    lines.push("");
  }
  lines.push("</details>");
  lines.push("");
  return { md: lines.join("\n"), problems, unused, stats: { commits: commits.length, claimedCount, preWindow: preWindow.length, translated, english } };
}

const stripGenerated = (md) => md.replace(GENERATED_ROW, "| Generated | (ignored) |");

/**
 * Freshness, in two grades. `problems` (always exit 1): the file must equal what this script renders from the
 * commit its Generated row names. `stale` (a note by default, exit 1 under --strict): every commit after that
 * one should have regenerated it. Returns { problems: string[], stale: string | null }.
 */
function checkFreshness(out, ref, head) {
  const problems = [];
  const fail = (p) => ({ problems: [p], stale: null });
  let file;
  try { file = readFileSync(out, "utf8"); } catch { return fail(`${relative(ROOT, out)}: missing — run \`node scripts/ethonline-commits-en.mjs\``); }
  const m = GENERATED_ROW.exec(file);
  if (!m) return fail(`${relative(ROOT, out)}: no "| Generated | … from \`<sha>\` |" row — regenerate`);
  const pinned = m[1];
  if (git(["cat-file", "-e", `${pinned}^{commit}`], null).status !== 0) return fail(`${relative(ROOT, out)}: Generated row names ${pinned.slice(0, 7)}, which is not a commit here`);
  if (git(["merge-base", "--is-ancestor", pinned, head], null).status !== 0) problems.push(`${relative(ROOT, out)}: generated from ${pinned.slice(0, 7)}, which is not an ancestor of ${ref} (${head.slice(0, 7)})`);
  const again = render(pinned, new Date()).md;
  if (stripGenerated(again) !== stripGenerated(file)) {
    const a = stripGenerated(file).split("\n"), b = stripGenerated(again).split("\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    problems.push(`${relative(ROOT, out)}: not what the script renders from ${pinned.slice(0, 7)} (first difference at line ${i + 1}: file ${JSON.stringify((a[i] ?? "").slice(0, 80))} vs render ${JSON.stringify((b[i] ?? "").slice(0, 80))}) — regenerate`);
  }
  // Commits after the pinned one that did not touch this file are missing from it. The file's identity in
  // history is the canonical path, whatever copy `--out` points at (a test checks a copy in a temp dir).
  const relOut = relative(ROOT, DEFAULT_OUT);
  const label = relative(ROOT, out);
  const after = git(["log", "--format=%H%x1f%s", `${pinned}..${head}`]).out.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
  const touched = new Set(git(["log", "--format=%H", `${pinned}..${head}`, "--", relOut]).out.split("\n").filter(Boolean));
  const missing = after.filter(([sha]) => !touched.has(sha));
  const stale = missing.length
    ? `${label}: stale — ${missing.length} commit(s) since ${pinned.slice(0, 7)} did not regenerate it (${missing.map(([s, subj]) => `${s.slice(0, 7)} ${subj.slice(0, 60)}`).join("; ")}); run \`node scripts/ethonline-commits-en.mjs\` before the submission Release`
    : null;
  return { problems, stale };
}

function main() {
  const { check, strict, ref, out } = parseArgs(process.argv.slice(2));
  const head = git(["rev-parse", `${ref}^{commit}`]).out.trim();
  const { md, problems, unused, stats } = render(head, new Date());
  let stale = null;
  if (check) {
    const f = checkFreshness(out, ref, head);
    problems.push(...f.problems);
    if (f.stale) { if (strict) problems.push(f.stale); else stale = f.stale; }
  }

  for (const p of problems) console.error(`ethonline-commits-en: ${p}`);
  if (stale) console.error(`ethonline-commits-en: note: ${stale}`);
  for (const s of unused) console.error(`ethonline-commits-en: note: translation for ${s.slice(0, 7)} is not in ${TAG}..${ref} (unused)`);

  if (!check) {
    writeFileSync(out, md);
    console.log(`wrote ${out}`);
  }
  // file: fresh (matches its pinned commit, nothing after it) / stale (behind, a note only) / STALE (exit 1: hand edit, or stale under --strict)
  const fileState = !check ? "" : problems.some((p) => p.includes("stale") || p.includes("regenerate")) ? "STALE" : stale ? "stale (note)" : "fresh";
  console.log(`ethonline-commits-en: ${stats.commits} commits (${stats.claimedCount} claimed, ${stats.preWindow} claimed pre-window), ${stats.translated} translated, ${stats.english} English${check ? `, file ${fileState}` : ""}, ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error(`ethonline-commits-en: ${e.message}`);
  process.exit(1);
}
