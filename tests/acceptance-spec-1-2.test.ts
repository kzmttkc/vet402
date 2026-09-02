// ============================================================
// 製品定義書 §15 受け入れテスト——機械で検査できるものだけをここに固定する。
// 実運用でしか確かめられない項目（無作為 100 件の L0・20 件の L1・Validation
// Registry の実レコード）は docs/ethonline-2026/SPEC_1_2_IMPACT.md §5 に実測で記す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { buildDecision, type DecisionSubject } from "@/lib/decision/decide";
import { decidePayer } from "@/lib/decision/rules";
import type { SellerFacts } from "@/lib/decision/types";
import { isPublishableFailure } from "@/lib/evidence/publishable";
import type { CensusSummary } from "@/lib/settlements/census";

const ROOT = process.cwd();

const subject: DecisionSubject = {
  type: "resource",
  id: "r".repeat(64),
  endpoint_id: "e".repeat(64),
  observatory_id: "00000000-0000-0000-0000-000000000001",
  canonical_url: "https://e.com/x",
  method: "GET",
};
const facts: SellerFacts = {
  l0: { status: "pass", observed_at: "2026-09-02T00:00:00Z", dialect: "v2", fail_reason: null },
  l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, n_probe_error: 0, p50_ms: 1, p95_ms: 1, last_purchase_id: "eip155:8453:0x1", observed_at: "2026-09-01T00:00:00Z" },
  l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: [],
  settlement_30d_real: 0,
  settlement_30d_raw: 0,
  settlement_30d_test: 0,
  unique_payers_30d_real: 0,
  wash_dominated: false,
};

test("§15: /decision?role=payer が facts なしでスコアだけ返す経路がテストに存在しない（型と出力で固定）", () => {
  const d = buildDecision({ role: "payer", subject, facts, options: {}, score: { trustScore: 90, recommendation: "ALLOW" }, registry: { status: "off", tx_hash: null } });
  assert.ok(d.facts && typeof d.facts === "object");
  assert.equal("trustScore" in (d.facts as object), false);
  // BuildInput の facts は必須引数。省略はコンパイルエラー——ここでは実行時にも確かめる。
  assert.throws(() => buildDecision({ role: "payer", subject, facts: undefined as unknown as SellerFacts, options: {}, score: null, registry: { status: "off", tx_hash: null } }));
});

test("§15: L3 を ON にしても ALLOW/BLOCK が変わらない", () => {
  const base = decidePayer(facts).recommendation;
  const withQuality = decidePayer({ ...facts, quality: { score: 0, rubric: "v1" } } as unknown as SellerFacts).recommendation;
  assert.equal(withQuality, base);
  const blocked = decidePayer({ ...facts, l0: { ...facts.l0, status: "fail" }, quality: { score: 100 } } as unknown as SellerFacts).recommendation;
  assert.equal(blocked, "BLOCK");
});

test("§15: wash_flag 付き決済を除外した数字と生値が両方見える（型が両方を必須にする）", () => {
  const keys: (keyof CensusSummary)[] = ["settlements_raw", "settlements_real", "unique_payers_raw", "unique_payers_real", "wash"];
  const sample: CensusSummary = {
    chain: "all", window: "30d", settlements_raw: 4, settlements_real: 2,
    wash: { self_deal: 1, circular: 0, test: 1 }, attribution: { confirmed: 2, probable: 1, unmatched: 1 },
    unique_payers_raw: 3, unique_payers_real: 1, unique_payees_real: 1, endpoints_with_real_settlement: 1,
    by_source: { l1_purchase: 1, payments_api: 3, chain_index: 0 }, definition: "", disclaimer: "", retrievedAt: "",
  };
  for (const k of keys) assert.ok(k in sample);
  assert.notEqual(sample.settlements_raw, sample.settlements_real);
});

test("§15: 公開してよい失敗は証拠が揃ったものだけ", () => {
  assert.equal(isPublishableFailure({ observed_at: "t", resource_id: "r", canonical_url: "u", probe_type: "L1", raw_summary: { status: 500, headers: [], error: "x" }, repro: { method: "GET", dialect: "v2", client: "c" } }), false);
  assert.equal(isPublishableFailure({ observed_at: "t", resource_id: "r", canonical_url: "u", probe_type: "L1", raw_summary: { status: 500, headers: [], error: "x" }, repro: { method: "GET", dialect: "v2", client: "c" }, tx_hash: "0x1", chain: "eip155:8453" }), true);
});

test("§15 / AGENTS.md: 買い手モード（role=payer で送金を止める配線）が 9/2 のパッケージに存在しない", () => {
  // packages/middleware と packages/sdk の SpendGuard に、/decision を role=payer で引く呼び出しが無いことを AST で確かめる。
  const files = ["packages/middleware/src/core.ts", "packages/sdk/src/spend-guard.ts"];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true);
    let payerDecisionCalls = 0;
    const visit = (n: ts.Node) => {
      if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) {
        const text = n.getText(sf);
        if (/\/decision/.test(text) && /role=payer/.test(text)) payerDecisionCalls++;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.equal(payerDecisionCalls, 0, `${f} に role=payer の /decision 呼び出しがある——9/4 まで入れない`);
  }
});

test("§15: ミドルウェアの売り手モードは role=payee 固定（文字列として存在する）", () => {
  const src = readFileSync(join(ROOT, "packages/middleware/src/core.ts"), "utf8");
  assert.match(src, /decision\?role=payee&payer=/);
});
