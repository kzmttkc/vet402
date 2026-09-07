#!/usr/bin/env node
// ============================================================
// SKILL.md の「本番向けコードブロック」を実走し、期待と違えば赤にする関門（2026-09-08）。
//
//   node scripts/skill-live-check.mjs              # 印付きブロックを上から実行し、表を出す。1 つでも不一致なら exit 1
//   node scripts/skill-live-check.mjs --list       # 対象一覧だけ（実行しない）
//   node scripts/skill-live-check.mjs --dry-run    # 実行せずに、何を走らせるかだけ表示
//   node scripts/skill-live-check.mjs --doc SKILL.md --root .   # 既定値
//
// なぜ: 2026-09-07 の監査で、SKILL.md の curl（`jq '.resources[0].resource_id'`）が本番では null を返すのに
// 文書は緑の顔をしていた。文書が未来を書き、誰も再実行しなかった。「まっさらな clone で上から通す」を
// 09-10 に人がやる予定だったが、人の予定は一度きりで、文書は毎日古くなる。だから機械にする。
//
// 印の形（```bash フェンスの直後 1 行目・bash のコメントなので審査員がそのまま貼っても無害）:
//   # live: expect <jq 式>
//   # live: needs VAR[,VAR] expect <jq 式>     ← VAR が env に無ければ実行せず skip と数える（CI は secrets から渡す）
// ブロック本文を bash -o pipefail で cwd=リポ直下から実行し、stdout 全体を `jq -s`（複数の JSON 値を配列に束ねる）に
// かけて <jq 式> が true になれば ok。それ以外（式が false／stdout が JSON でない／終了コード非 0）は FAIL。
// 印の無いブロック・bash 以外のフェンス・2 行目以降の印は対象外（実行しない）。
// 壊れた印は exit 1、印が 1 つも無い文書も exit 1（何も見ていない緑を出さない）。
//
// 依存: node と jq だけ（jq は SKILL.md のブロック自身が使う）。秘密は印字しない——env の**名前**だけを表に出す。
// 本番の鍵なし /decision は IP あたり 10/分。印を付けるブロックは、1 回の実走で /decision 3 本以内・本番 GET 20 本以内に
// 収める（どのブロックに印を付けるかは SKILL.md 側の責任。この計器は数えない）。
// ============================================================
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MARKER = /^# live:(.*)$/;
const MARKER_BODY = /^\s*(?:needs\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+)?expect\s+(\S.*)$/;
const TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const o = { root: process.cwd(), doc: "SKILL.md", list: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") o.list = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--root") o.root = resolve(argv[++i]);
    else if (a === "--doc") o.doc = argv[++i];
    else if (a === "-h" || a === "--help") { printUsage(); process.exit(0); }
    else { console.error(`skill-live-check: unknown option: ${a}`); process.exit(2); }
  }
  return o;
}

function printUsage() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 9).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

/**
 * Markdown から「```bash フェンスの 1 行目が `# live:`」のブロックだけを取り出す。
 * @returns {{ blocks: Array<{heading:string, line:number, needs:string[], expect:string, body:string}>, errors: string[] }}
 */
export function extractBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  const errors = [];
  let heading = "(no heading)";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { heading = h[1].trim(); i++; continue; }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (!fence) { i++; continue; }
    const lang = fence[1];
    const start = i;
    const body = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
    i++; // closing fence
    if (lang !== "bash" || body.length === 0) continue;
    const m = MARKER.exec(body[0]);
    if (!m) continue;
    const mb = MARKER_BODY.exec(m[1]);
    if (!mb) { errors.push(`line ${start + 2}: malformed marker: ${body[0]}`); continue; }
    const needs = mb[1] ? mb[1].split(",").map((s) => s.trim()) : [];
    blocks.push({ heading, line: start + 1, needs, expect: mb[2].trim(), body: body.join("\n") });
  }
  return { blocks, errors };
}

function runBlock(block, root) {
  const start = Date.now();
  const r = spawnSync("bash", ["-o", "pipefail", "-c", block.body], {
    cwd: root, encoding: "utf8", timeout: TIMEOUT_MS, env: process.env,
  });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const stdout = r.stdout ?? "";
  if (r.error) return { status: "FAIL", note: `${r.error.code === "ETIMEDOUT" ? `timeout ${TIMEOUT_MS / 1000}s` : r.error.message}`, secs, stdout };
  if (r.status !== 0) return { status: "FAIL", note: `exit ${r.status}${r.stderr ? ` — ${firstLine(r.stderr)}` : ""}`, secs, stdout };
  const jq = spawnSync("jq", ["-s", block.expect], { input: stdout, encoding: "utf8", timeout: 10_000 });
  if (jq.error) return { status: "FAIL", note: `jq: ${jq.error.message}`, secs, stdout };
  if (jq.status !== 0) {
    const err = firstLine(jq.stderr ?? "");
    const notJson = /parse error/i.test(err);
    return { status: "FAIL", note: notJson ? `stdout is not JSON — ${err}` : `jq exit ${jq.status} — ${err}`, secs, stdout };
  }
  const verdict = (jq.stdout ?? "").trim();
  if (verdict === "true") return { status: "ok", note: "", secs, stdout };
  return { status: "FAIL", note: `expect → ${verdict.slice(0, 60)} (want true)`, secs, stdout };
}

function firstLine(s) { return (s ?? "").trim().split("\n")[0].slice(0, 120); }

function table(rows) {
  const w = [2, 6, 48, 6];
  const fmt = (c) => c.map((v, k) => String(v).padEnd(w[k])).join(" ");
  console.log(fmt(["#", "status", "block (heading @ line)", "sec"]) + " note");
  console.log(fmt(["--", "------", "-".repeat(48), "----"]) + " ----");
  rows.forEach((r, k) => console.log(fmt([k + 1, r.status, `${r.heading} @${r.line}`.slice(0, 48), r.secs ?? "-"]) + ` ${r.note ?? ""}`));
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const docPath = join(opt.root, opt.doc);
  const { blocks, errors } = extractBlocks(readFileSync(docPath, "utf8"));
  console.log(`skill-live-check: ${opt.doc} — ${blocks.length} block${blocks.length === 1 ? "" : "s"} marked \`# live:\`${opt.list ? " (list)" : opt.dryRun ? " (dry-run, nothing executed)" : ""}`);
  for (const e of errors) console.log(`  ERROR ${e}`);
  if (errors.length) { console.log(`skill-live-check: ${errors.length} malformed marker(s) — fix the marker(s) above`); process.exit(1); }

  if (opt.list || opt.dryRun) {
    blocks.forEach((b, k) => {
      console.log(`${k + 1}. ${b.heading} @${b.line}${b.needs.length ? `  needs ${b.needs.join(",")}` : ""}`);
      console.log(`   expect ${b.expect}`);
      if (opt.dryRun) console.log(b.body.split("\n").slice(1).map((l) => `   | ${l}`).join("\n"));
    });
    process.exit(0);
  }

  if (blocks.length === 0) { console.log("skill-live-check: no marked blocks — nothing was checked, so this is not green"); process.exit(1); }

  const rows = [];
  for (const b of blocks) {
    const missing = b.needs.filter((v) => !process.env[v]);
    if (missing.length) { rows.push({ ...b, status: "skip", note: `needs ${missing.join(",")} (unset)`, secs: "-" }); continue; }
    const r = runBlock(b, opt.root);
    rows.push({ ...b, ...r });
    if (r.status === "FAIL") {
      const head = (r.stdout ?? "").trim().split("\n").slice(0, 12).map((l) => `  | ${l.slice(0, 200)}`).join("\n");
      if (head) console.log(`--- stdout of "${b.heading}" (first lines) ---\n${head}\n---`);
    }
  }
  console.log();
  table(rows);
  const ok = rows.filter((r) => r.status === "ok").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const skip = rows.filter((r) => r.status === "skip").length;
  console.log(`\nskill-live-check: ${ok} ok, ${fail} fail, ${skip} skip of ${rows.length}`);
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
