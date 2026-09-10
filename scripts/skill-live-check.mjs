#!/usr/bin/env node
// ============================================================
// SKILL.md の ```bash ブロックを全数会計し、本番向けのものは実走して期待と違えば赤にする関門（2026-09-08）。
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
// なぜ全数会計にしたか（2026-09-08 の第三者監査）: 印は 12 本中 4 本にしか付いておらず、印の**外**に置かれた
// ブロックは誰も走らせていなかった。そこに 09-07 の walk をすり抜けた腐りが 2 本あった——`tools/call` の
// JSON が複数行に折られており、stdio の MCP は 1 行 1 メッセージなので黙って捨てられ、`2>/dev/null` が
// エラーも消していた。審査員が貼ると `initialize` の応答しか返らない。**緑を出している計器ほど、
// 何を見ていないかを確かめる。** だから: (1) ```bash ブロックは全部、印を持たなければ赤（黙って外せない）。
// (2) 走らせられないものは `skip <理由>` と**その場に理由を書く**。(3) 実走できない本にも効く静的検査を足す
// ——JSON-RPC のメッセージが 1 行に収まっているか（鍵も本番アクセスも要らずに、あの腐りだけを捕まえる）。
//
// 印の形（```bash フェンスの直後 1 行目・bash のコメントなので審査員がそのまま貼っても無害）:
//   # live: expect <jq 式>
//   # live: needs VAR[,VAR] expect <jq 式>     ← VAR が env に無ければ実行せず skip と数える（CI は secrets から渡す）
//   # live: skip <理由>                        ← 実走しない本。理由は必須（「なぜ印の外か」をその場に残す）
//   needs の項目は env 変数名のほか `module:<指定子>@<ディレクトリ>` を取る（例:
//   `module:viem/accounts@packages/mcp-server`）。そのディレクトリから指定子が解決できなければ、
//   env が無いときと同じく実行せず skip と数える。
//   なぜ module を足したか（2026-09-10）: `pay_if_trusted` の evidence 系 2 本は、鍵を 3 本とも渡しても
//   `packages/mcp-server` に viem が無ければ `payer_not_configured` で止まり、The Graph を一度も読まない
//   （`resolvePayer()` は鍵と viem の**両方**が揃ったときだけ署名者を返す）。viem は意図的に依存ではないので
//   `npm ci` では入らない。この計器は env しか見ていなかったため、THROWAWAY_KEY を持たない CI では
//   その 2 本が skip となり、欠陥は緑のまま通っていた（鍵を持つ人の手元では、逆に本番が壊れたかのような
//   赤が出る——CI の issue 本文は「本番に合わせて SKILL.md を直せ」と言う。どちらの顔も誤り）。
//   **緑を出している計器ほど、何を見ていないかを確かめる。**
// ブロック本文を bash -o pipefail で cwd=リポ直下から実行し、stdout 全体を `jq -s`（複数の JSON 値を配列に束ねる）に
// かけて <jq 式> が true になれば ok。それ以外（式が false／stdout が JSON でない／終了コード非 0）は FAIL。
// bash 以外のフェンス・2 行目以降の印は対象外。壊れた印・**印の無い ```bash ブロック**・印がゼロの文書は exit 1。
//
// 静的検査（印の種類によらず全 ```bash ブロックに適用・実行しない）:
//   JSON-RPC lint — `{"jsonrpc"` を含む行は、その行だけで 1 つの JSON 値として閉じていなければ赤。
//   stdio の MCP は改行区切りなので、折られた要求は相手に届かず、しかも黙って消える。
//
// 依存: node と jq だけ（jq は SKILL.md のブロック自身が使う）。秘密は印字しない——env の**名前**だけを表に出す。
// 本番の鍵なし /decision は IP あたり 10/分。印を付けるブロックは、1 回の実走で /decision 3 本以内・本番 GET 20 本以内に
// 収める（どのブロックに印を付けるかは SKILL.md 側の責任。この計器は数えない）。
// ============================================================
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const MARKER = /^# live:(.*)$/;
// needs の 1 項目: env 変数名か `module:<指定子>@<ディレクトリ>`。
const NEED = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|module:[^\s,]+@[^\s,]+)`;
const MARKER_RUN = new RegExp(String.raw`^\s*(?:needs\s+(${NEED}(?:\s*,\s*${NEED})*)\s+)?expect\s+(\S.*)$`);
const MARKER_SKIP = /^\s*skip\s+(\S.*)$/;
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
 * Markdown から ```bash ブロックを**全部**取り出す。1 行目の `# live:` 印で run / skip を分ける。
 * 印の無い ```bash ブロックは errors に積む（黙って対象外にしない）。
 * 静的検査は印の有無によらず全 ```bash ブロックに掛けたいので、allBash も返す。
 * @returns {{ blocks: Array<{heading:string, line:number, kind:"run"|"skip", needs:string[], expect?:string, reason?:string, body:string}>, allBash: Array<{heading:string, line:number, body:string}>, errors: string[] }}
 */
export function extractBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  const allBash = [];
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
    if (lang !== "bash") continue;
    allBash.push({ heading, line: start + 1, body: body.join("\n") });
    const at = `line ${start + 1}`;
    if (body.length === 0) { errors.push(`${at}: empty \`\`\`bash block`); continue; }
    const m = MARKER.exec(body[0]);
    if (!m) {
      errors.push(`${at} (${heading}): \`\`\`bash block with no \`# live:\` marker — every bash block must say what it is: \`expect <jq>\`, \`needs VAR expect <jq>\`, or \`skip <reason>\``);
      continue;
    }
    const run = MARKER_RUN.exec(m[1]);
    if (run) {
      const needs = run[1] ? run[1].split(",").map((s) => s.trim()) : [];
      blocks.push({ heading, line: start + 1, kind: "run", needs, expect: run[2].trim(), body: body.join("\n") });
      continue;
    }
    const skip = MARKER_SKIP.exec(m[1]);
    if (skip) {
      blocks.push({ heading, line: start + 1, kind: "skip", needs: [], reason: skip[1].trim(), body: body.join("\n") });
      continue;
    }
    errors.push(`${at}: malformed marker: ${body[0]}`);
  }
  return { blocks, allBash, errors };
}

/**
 * 静的検査: stdio の MCP は 1 行 1 メッセージ。`{"jsonrpc"` を含む行がその行だけで閉じていなければ赤。
 * 折られた要求は相手に届かず、しかも黙って消える（2026-09-08 の監査で SKILL.md に 2 本あった）。
 * @returns {string[]} 見つかった問題（空なら緑）
 */
export function lintJsonRpcLines(blocks) {
  const problems = [];
  for (const b of blocks) {
    b.body.split("\n").forEach((line, k) => {
      const at = line.indexOf('{"jsonrpc"');
      if (at < 0) return;
      // その行だけで `{` が閉じるかを見る。行の後ろにシェルの続き（`' \` など）が付いていてよい。
      let depth = 0, inString = false, escaped = false, closed = false;
      for (let i = at; i < line.length; i++) {
        const c = line[i];
        if (escaped) { escaped = false; continue; }
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) { closed = true; break; }
      }
      if (!closed) {
        problems.push(
          `line ${b.line + 1 + k} (${b.heading}): a JSON-RPC message is folded across lines — stdio MCP reads one message per line, so this request is dropped without a word. Put the JSON on one line.`,
        );
      }
    });
  }
  return problems;
}

/**
 * needs の 1 項目が満たされているか。env 変数は env に在るか、`module:<指定子>@<ディレクトリ>` は
 * そのディレクトリから指定子が **実際に解決できるか**（`package.json` の記載ではなく node の解決）。
 * 記載を見ると嘘をつく: viem は `packages/mcp-server/package.json` に**書かれていない**のが正しい状態で、
 * それでも解決できることが要る。
 * @returns {string|null} 満たされていなければ表に出す短い理由、満たされていれば null
 */
export function unmetNeed(need, root) {
  if (!need.startsWith("module:")) return process.env[need] ? null : `${need} (unset)`;
  const rest = need.slice("module:".length);
  const at = rest.lastIndexOf("@");
  if (at <= 0) return `${need} (malformed — want module:<specifier>@<dir>)`;
  const specifier = rest.slice(0, at);
  const dir = rest.slice(at + 1);
  try {
    createRequire(join(root, dir, "noop.js")).resolve(specifier);
    return null;
  } catch {
    return `${specifier} not resolvable from ${dir} (unmet)`;
  }
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
  const { blocks, allBash, errors } = extractBlocks(readFileSync(docPath, "utf8"));
  const runnable = blocks.filter((b) => b.kind === "run");
  const excused = blocks.filter((b) => b.kind === "skip");
  const mode = opt.list ? " (list)" : opt.dryRun ? " (dry-run, nothing executed)" : "";
  console.log(
    `skill-live-check: ${opt.doc} — ${allBash.length} \`\`\`bash block${allBash.length === 1 ? "" : "s"}, ` +
      `${blocks.length} accounted for (${runnable.length} marked \`# live:\`, ${excused.length} excused \`skip\`)${mode}`,
  );
  for (const e of errors) console.log(`  ERROR ${e}`);

  // 静的検査は印の種類によらず全ブロックに掛ける。鍵も本番アクセスも要らない。
  const lint = lintJsonRpcLines(allBash);
  for (const p of lint) console.log(`  ERROR ${p}`);

  if (errors.length || lint.length) {
    console.log(`skill-live-check: ${errors.length + lint.length} static error(s) — fix the block(s) above`);
    process.exit(1);
  }

  if (opt.list || opt.dryRun) {
    blocks.forEach((b, k) => {
      if (b.kind === "skip") { console.log(`${k + 1}. ${b.heading} @${b.line}  skip — ${b.reason}`); return; }
      console.log(`${k + 1}. ${b.heading} @${b.line}${b.needs.length ? `  needs ${b.needs.join(",")}` : ""}`);
      console.log(`   expect ${b.expect}`);
      if (opt.dryRun) console.log(b.body.split("\n").slice(1).map((l) => `   | ${l}`).join("\n"));
    });
    process.exit(0);
  }

  if (runnable.length === 0) { console.log("skill-live-check: no marked blocks — nothing was checked, so this is not green"); process.exit(1); }

  const rows = [];
  for (const b of blocks) {
    if (b.kind === "skip") { rows.push({ ...b, status: "skip", note: b.reason, secs: "-" }); continue; }
    const missing = b.needs.map((n) => unmetNeed(n, opt.root)).filter(Boolean);
    if (missing.length) { rows.push({ ...b, status: "skip", note: `needs ${missing.join("; ")}`, secs: "-" }); continue; }
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
