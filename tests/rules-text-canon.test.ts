// ============================================================
// 判定の規則の文は 1 か所（src/lib/decision/rules-text.ts・reason-codes.ts・fix-modes.ts の BUCKET_DOCS）から出す
// （2026-09-29 監査 7 周目・オーナーの確認）。静的な面は scripts/gen-rules-text.ts が書き出し、ここで一致しないと落ちる。
// 直し方: `npx tsx scripts/gen-rules-text.ts` を打って、書き出された差分を commit する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAll } from "../scripts/gen-rules-text";
import { DECISION_RULES_TEXT, VERDICT_DOCS } from "@/lib/decision/rules-text";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { BUCKET_DOCS, LATE_LINK_PENDING_MINUTES } from "@/lib/sellers/fix-modes";
import { reasonCodeDocOf } from "@/lib/decision/reason-codes";
import { SELLER_EXPORT_COLUMN_NOTES } from "@/lib/sellers/export";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("静的な面（llms.txt・openapi.yaml・MCP の生成物）は正典から書き出したものと一致する", () => {
  for (const f of renderAll(ROOT)) {
    assert.ok(f.current.length > 0, `${f.path} が無い`);
    assert.equal(f.current === f.expected, true, `${f.path} が正典と食い違う。npx tsx scripts/gen-rules-text.ts を打つ`);
  }
});

test("動的な面（/docs/api・llms-full.txt・MCP の説明）は正典を import して埋め込む", () => {
  const docs = read("src/app/docs/api/page.tsx");
  assert.match(docs, /DECISION_RULES_TEXT/);
  assert.match(docs, /VERDICT_DOCS\[v\]/);
  assert.match(docs, /Reason codes \(rules \{DECISION_RULES_VERSION\}\)/);
  assert.match(read("src/app/llms-full.txt/route.ts"), /\$\{DECISION_RULES_TEXT\}/);
  const mcp = read("packages/mcp-server/src/index.ts");
  assert.match(mcp, /from "\.\/rules-text\.generated\.js"/);
  assert.match(mcp, /^\s+DECISION_RULES_TEXT,$/m);
  assert.match(read("packages/mcp-server/dist/rules-text.generated.js"), new RegExp(DECISION_RULES_VERSION.replace(/\./g, "\\.")), "dist を再ビルドする");
});

test("手で書いた古い規則の文が面に残っていない（旧版の版番号・消した語）", () => {
  const surfaces = [
    "src/app/docs/api/page.tsx",
    "src/app/llms-full.txt/route.ts",
    "public/llms.txt",
    "docs/openapi.yaml",
    "packages/mcp-server/src/index.ts",
    "src/components/site/sellers/DecisionAnswer.tsx",
  ];
  for (const s of surfaces) {
    const src = read(s);
    // 「Rules 2026-09-29.3:」「Rules 2026-09-29.3 (rules_version)」の形の規則の文（「(rules 2026-09-29.2)」のような導入の版の注記は除く）
    assert.doesNotMatch(src, /[Rr]ules 2026-09-29\.[0-3](:| \(|\. )/, `${s}: 旧版の規則の文`);
    assert.doesNotMatch(src, /l0_unverified_single_fail_unconfirmed/, `${s}: 消した語`);
    assert.doesNotMatch(src, /once is (a )?WARN,? (and )?twice (or more )?is (a )?BLOCK/i, `${s}: 旧規則（2 回で BLOCK）`);
  }
});

test("区分の説明は BUCKET_DOCS の 1 か所（export.csv の列の説明・規則の文が同じ語を使う）", () => {
  for (const d of Object.values(BUCKET_DOCS)) {
    assert.ok(SELLER_EXPORT_COLUMN_NOTES.includes(d), `export の説明に無い: ${d.slice(0, 30)}`);
    assert.ok(DECISION_RULES_TEXT.includes(d), `規則の文に無い: ${d.slice(0, 30)}`);
  }
  assert.ok(DECISION_RULES_TEXT.startsWith(`Rules ${DECISION_RULES_VERSION} `));
  assert.match(VERDICT_DOCS.BLOCK, /on the seller's side/);
  assert.match(VERDICT_DOCS.WARN, /unverified/);
});

test("理由コードの表（型以外を import しない純データ）に書いた数は定数と同じ", () => {
  assert.match(reasonCodeDocOf("l1_empty_2xx_settlement_unknown")!.meaning, new RegExp(`less than ${LATE_LINK_PENDING_MINUTES} minutes`));
});
