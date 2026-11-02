// ============================================================
// 公開面が定義を言い換えて強く言わないこと（2026-11-02 公開面の文言監査）。
//
// WHY: delivered の定義は「settled のあと 202 以外の 2xx が本文つきで返った」で、中身の正しさは見ない。
// 11/02 に方法論・記録頁・バッジの言い方（got no 2xx、response arriving）を直したのに、同じ型の文が
// トップ・FAQ・ブログに残っていた。1 か所ずつ直すと戻るので、実際に誤っていた言い方だけをここで止める。
// active も同じで、Bazaar の行は 10/30 から閉じないのに「いま載っている」と書いていた（117,114 と 51,833）。
//
// 禁止語を足すときは、実際に公開面で誤っていた文に限る。正しい用法まで止めない
// （例: deliveredLine の "no 2xx" は非 2xx の 1 行の表示で正しいので、"got no 2xx" だけを止める）。
//
// 見る面は公開の文を持つファイルだけ。src/lib/observatory のサーバーコードの文字列では落とさない
// （語彙だけは公開の定義なので見る）。機械が読む面（llms.txt・openapi・package.json）も見る。
// 見ない面: /rwa・/tokyo・/ethonline（凍結）、/corrections（過去の誤りを引用する面）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "@/lib/claims/extract";
import { EVM_PAY_CHAINS } from "@/lib/observatory/x402-payer";
import { publicChainLabel } from "@/lib/observatory/chains";
import { SETTLEMENT_ASSETS } from "@/lib/observatory/settlement-assets";
import { withSettledTier } from "@/lib/observatory/reader";
import { settlementSourceSql } from "@/lib/observatory/settlement-source";

const ROOT = process.cwd();

/** 公開の文が置かれる場所。 */
const SCAN_ROOTS = [
  "src/app",
  "src/components",
  "src/lib/blog.ts",
  "src/lib/docs",
  "src/lib/mcp",
  "src/lib/observatory/vocabulary.ts",
  "public/llms.txt",
  "docs/openapi.yaml",
  "README.md",
  "package.json",
];

const FROZEN_OR_QUOTING = [
  "src/app/rwa/",
  "src/app/tokyo/",
  "src/app/ethonline/",
  "src/app/corrections/",
];

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\bresponse arriv(?:e|es|ed|ing)\b/i, why: "4xx も 202 も応答は来る。delivered は 202 以外の 2xx が本文つき" },
  { pattern: /\bgot no 2xx\b/i, why: "settled − delivered には 202・空の本文・記録なしが入る" },
  { pattern: /\bgot a response\b/i, why: "応答が来たことと delivered は別" },
  { pattern: /what was paid for arrived/i, why: "中身を見ていないのに「届いた」と言っている" },
  { pattern: /statement about the goods/i, why: "delivered は応答の話で、品物の話ではない" },
  { pattern: /paid request actually answered/i, why: "4xx も答えに入る" },
  { pattern: /verifies fulfillment/i, why: "宣言と照合できる配達は一部。宣言の無い掲載は照合していない" },
  { pattern: /deliver as declared/i, why: "ALLOW は宣言も今も保証しない" },
  { pattern: /currently listed/i, why: "active は閉じていない行で、Bazaar の行は目録から消えても active のまま" },
  { pattern: /active listed/i, why: "同上" },
  { pattern: /means listed as of the latest snapshot/i, why: "同上" },
];

function walk(dir: string, out: string[] = []): string[] {
  const full = join(ROOT, dir);
  if (statSync(full).isFile()) {
    out.push(dir);
    return out;
  }
  for (const entry of readdirSync(full)) {
    const path = join(full, entry);
    if (statSync(path).isDirectory()) walk(relative(ROOT, path), out);
    else if (/\.tsx?$/.test(path)) out.push(relative(ROOT, path));
  }
  return out;
}

const surfaces = SCAN_ROOTS.flatMap((d) => walk(d)).filter((f) => !FROZEN_OR_QUOTING.some((skip) => f.startsWith(skip)));

test("the scan reads the pages that carried the wrong wording", () => {
  for (const page of [
    "src/app/page.tsx",
    "src/app/observatory/page.tsx",
    "src/app/observatory/state/page.tsx",
    "src/app/impact/page.tsx",
    "src/app/playground/page.tsx",
    "src/components/site/faq-data.ts",
    "src/components/site/HomeLedger.tsx",
    "src/lib/observatory/vocabulary.ts",
    "src/lib/blog.ts",
    "src/app/llms-full.txt/route.ts",
    "src/app/layout.tsx",
    "public/llms.txt",
    "docs/openapi.yaml",
  ]) {
    assert.ok(surfaces.includes(page), `not scanned: ${page}`);
  }
});

test("the forbidden list catches the sentences the audit found", () => {
  for (const sentence of [
    "Does payment settle and a response arrive?",
    "L1 asks whether a real purchase settled and the response arrived.",
    "publishes whether what was paid for arrived.",
    "delivered is a statement about the goods",
    "checks whether the paid request actually answered",
    "verifies fulfillment against the seller's own declaration",
    "Currently listed in the catalog",
  ]) {
    assert.ok(FORBIDDEN.some((f) => f.pattern.test(sentence)), `not caught: ${sentence}`);
  }
  // 非 2xx の 1 行を指す正しい表示は止めない。
  assert.ok(!FORBIDDEN.some((f) => f.pattern.test("no 2xx")));
});

test("no public surface restates a definition more strongly than it is measured", () => {
  const offenders: string[] = [];
  for (const file of surfaces) {
    const raw = readFileSync(join(ROOT, file), "utf8");
    const code = /\.tsx?$/.test(file) ? stripComments(raw) : raw;
    for (const { pattern, why } of FORBIDDEN) {
      const hit = pattern.exec(code.replace(/\s+/g, " "));
      if (hit) offenders.push(`${file}: "${hit[0]}" (${why})`);
    }
  }
  assert.deepEqual(offenders, [], `Reword these to match the definition:\n  ${offenders.join("\n  ")}`);
});

test("the asset table names every EVM chain vet402 can sign on", () => {
  // Arbitrum One と Avalanche C-Chain はレーンができても公開の一覧に足されなかった（監査 M1）。
  for (const chain of EVM_PAY_CHAINS) {
    const name = publicChainLabel(chain.caip2);
    const row = SETTLEMENT_ASSETS.find((r) => r.chain === name);
    assert.ok(row, `${name} is a payer lane and is missing from SETTLEMENT_ASSETS`);
    assert.equal(row.binding, "eip3009", `${name} signs an EIP-3009 authorization`);
    assert.equal(row.asset, chain.caip2 === "eip155:56" ? "USD1" : "USDC", name);
  }
});

// ---------- 2026-11-02 に足した 4 つのフィールド ----------

function purchaseRow(status: string, circleGateway: unknown) {
  return {
    status,
    txHash: null,
    network: "eip155:5042",
    authNonce: `0x${"a".repeat(64)}`,
    settlementVerified: status === "settled",
    lateSettlement: null,
    circleGateway,
    l2Schema: null,
    l2Detail: null,
    l2BodyHead: null,
    l2ContentType: null,
  };
}

test("gatewayBatchTx: a settled Gateway row carries its batch, and no other row does", () => {
  const batchTx = `0x${"b".repeat(64)}`;
  const [settled, failed, plain] = withSettledTier(
    [purchaseRow("settled", { batchTx }), purchaseRow("settle_failed", { batchTx }), purchaseRow("settled", null)],
    null,
  );
  assert.equal(settled.gatewayBatchTx, batchTx);
  assert.equal(settled.settlementSource, "circle_gateway");
  assert.equal(settled.txHash, null, "the shared batch stays out of txHash");
  assert.equal("circleGateway" in settled, false);
  assert.equal(failed.gatewayBatchTx, null);
  assert.equal(plain.gatewayBatchTx, null);
});

test("l1.settledCircleGateway counts settled rows by the same rule as settlement_source", () => {
  const reader = readFileSync(join(ROOT, "src/lib/observatory/reader.ts"), "utf8");
  assert.ok(
    reader.includes("count(*) FILTER (WHERE status = 'settled' AND (${sql.raw(settlementSourceSql())}) = 'circle_gateway')::int AS settled_circle_gateway"),
  );
  assert.ok(reader.includes("settledCircleGateway: Number(l1List[0].settled_circle_gateway ?? 0)"));
  assert.match(settlementSourceSql(), /circle_gateway/);
  // 実際の数え方は tests/export-request-body.pg.test.ts が実 DB で確かめる。
});
