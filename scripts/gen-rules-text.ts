// ============================================================
// 判定の規則の文を、静的な公開面へ書き出す（2026-09-29 監査 7 周目）。
//
//   正典: src/lib/decision/rules-text.ts（規則の文）・src/lib/decision/reason-codes.ts（理由コードの表）・
//         src/lib/decision/types.ts（L2_STATUSES）
//   書き出す先:
//     public/llms.txt                               <!-- rules-text:begin --> … <!-- rules-text:end --> の間
//     docs/openapi.yaml                             DecisionReasonCode の説明の版・enum・x-vet402-patterns、L2Status の enum、
//                                                   DecisionResult.reason_codes の説明
//     packages/mcp-server/src/rules-text.generated.ts  MCP の check_resource_decision の説明に埋め込む文
//
//   使い方: npx tsx scripts/gen-rules-text.ts          書き出す
//           npx tsx scripts/gen-rules-text.ts --check  書き出さずに差分があれば 1 で終わる
//   tests/rules-text-canon.test.ts が同じ関数（renderAll）で「正典と一致しないと落ちる」を固定する。
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DECISION_RULES_TEXT, OPENAPI_REASON_CODES_TEXT } from "../src/lib/decision/rules-text";
import { DECISION_RULES_VERSION } from "../src/lib/decision/rules";
import { FIXED_REASON_CODES, REASON_CODES } from "../src/lib/decision/reason-codes";
import { L2_STATUSES } from "../src/lib/decision/types";

const ROOT = join(__dirname, "..");
export const LLMS_TXT = "public/llms.txt";
export const OPENAPI = "docs/openapi.yaml";
export const MCP_GENERATED = "packages/mcp-server/src/rules-text.generated.ts";

const BEGIN = "<!-- rules-text:begin -->";
const END = "<!-- rules-text:end -->";

/** llms.txt は Markdown。コード名を `…` で囲む（語の形 [a-z0-9_<>]+ の識別子だけ）。 */
function markdownCodes(text: string): string {
  return text.replace(/\b((?:l0|l1|l2)_[a-z0-9_<>*]+|rules_version|degraded: true|mismatch_kind missing_keys)\b/g, "`$1`");
}

export function renderLlms(src: string): string {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${LLMS_TXT}: markers not found`);
  return `${src.slice(0, a + BEGIN.length)}${markdownCodes(DECISION_RULES_TEXT)}${src.slice(b)}`;
}

/** YAML の折り畳み（>-）の本文へ: 幅 76 で折り返し、indent を付ける。 */
function fold(text: string, indent: string, width = 76): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && indent.length + line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`).join("\n");
}

export function renderOpenapi(src: string): string {
  let s = src;
  // DecisionReasonCode: 版・enum・パターン
  const rcStart = s.indexOf("\n    DecisionReasonCode:\n");
  if (rcStart < 0) throw new Error("DecisionReasonCode not found");
  const rcEnd = rcStart + 1 + s.slice(rcStart + 1).search(/\n    [A-Za-z]/);
  let block = s.slice(rcStart, rcEnd);
  block = block.replace(/Since \d{4}-\d{2}-\d{2}\.\d+\./, `Since ${DECISION_RULES_VERSION}.`);
  block = block.replace(/\n      enum: \[[^\]]*\]/, `\n      enum: [${FIXED_REASON_CODES.join(", ")}]`);
  block = block.replace(
    /\n      x-vet402-patterns: \[.*\]/,
    `\n      x-vet402-patterns: ${JSON.stringify(REASON_CODES.filter((r) => r.pattern).map((r) => r.pattern!.source)).replace(/","/g, '", "')}`,
  );
  s = s.slice(0, rcStart) + block + s.slice(rcEnd);
  // L2Status の enum
  s = s.replace(/(\n    L2Status:\n      type: string\n      enum: )\[[^\]]*\]/, `$1[${L2_STATUSES.join(", ")}]`);
  // DecisionResult.reason_codes の説明
  const head = "\n        reason_codes:\n          type: array\n          items: { type: string }\n          description: >-\n";
  const i = s.indexOf(head);
  if (i < 0) throw new Error("DecisionResult.reason_codes not found");
  const bodyStart = i + head.length;
  const rest = s.slice(bodyStart);
  const next = rest.search(/\n {0,10}[^ \n]/);
  const bodyEnd = bodyStart + (next < 0 ? rest.length : next);
  s = s.slice(0, bodyStart) + fold(OPENAPI_REASON_CODES_TEXT, "            ") + s.slice(bodyEnd);
  return s;
}

export function renderMcp(): string {
  return [
    "// 生成物（手で書き換えない）: scripts/gen-rules-text.ts が src/lib/decision/rules-text.ts から書き出す。",
    "// tests/rules-text-canon.test.ts が正典との一致を固定する。",
    `export const DECISION_RULES_VERSION = ${JSON.stringify(DECISION_RULES_VERSION)};`,
    `export const DECISION_RULES_TEXT = ${JSON.stringify(DECISION_RULES_TEXT)};`,
    "",
  ].join("\n");
}

/** 各面の今の中身と、正典から作った中身。 */
export function renderAll(root = ROOT): { path: string; current: string; expected: string }[] {
  const read = (p: string) => {
    try {
      return readFileSync(join(root, p), "utf8");
    } catch {
      return "";
    }
  };
  const llms = read(LLMS_TXT);
  const openapi = read(OPENAPI);
  return [
    { path: LLMS_TXT, current: llms, expected: renderLlms(llms) },
    { path: OPENAPI, current: openapi, expected: renderOpenapi(openapi) },
    { path: MCP_GENERATED, current: read(MCP_GENERATED), expected: renderMcp() },
  ];
}

if (require.main === module) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const f of renderAll()) {
    if (f.current === f.expected) continue;
    stale++;
    if (check) console.error(`stale: ${f.path}`);
    else {
      writeFileSync(join(ROOT, f.path), f.expected);
      console.log(`wrote ${f.path}`);
    }
  }
  if (check && stale > 0) process.exit(1);
}
