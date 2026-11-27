// Key-less /decision limit 60/min (2026-11-15).
import { apiDocsPageText } from "./lib/api-docs-source";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DECISION_KEYLESS_LIMIT,
  keylessDecisionPerMinute,
  keylessRatesSentence,
} from "@/lib/api/keyless-limits";
import { BILLING_PLANS } from "@/lib/billing/plans";
import { DEV_NOTE } from "@/components/site/home/paths";
import { GET as getLlmsFullTxt } from "@/app/llms-full.txt/route";

test("DECISION_KEYLESS_LIMIT and helpers read 60 per minute", () => {
  assert.equal(DECISION_KEYLESS_LIMIT, 60);
  assert.equal(keylessDecisionPerMinute(), 60);
  assert.match(keylessRatesSentence(), /60 requests a minute/);
});

test("docs and static copy use 60 for /decision key-less, not hard-coded 10", () => {
  const page = apiDocsPageText();
  assert.match(page, /keylessDecisionPerMinute\(\)/);
  const decisionChunks = page.split("/decision");
  for (let i = 1; i < decisionChunks.length; i++) {
    const chunk = decisionChunks[i].slice(0, 400);
    if (/key-less|keyless/i.test(chunk)) {
      assert.doesNotMatch(chunk, /10\/min/, `docs chunk ${i}`);
      assert.doesNotMatch(chunk, /10 requests per minute per IP/i, `docs chunk ${i}`);
    }
  }
  const llms =
    readFileSync("public/llms.txt", "utf8") + readFileSync("public/llms-full-prose.txt", "utf8");
  assert.match(llms, /60\/min/);
  assert.doesNotMatch(llms, /Key-less at 10\/min per IP/);
  const openapi = readFileSync("docs/openapi.yaml", "utf8");
  const start = openapi.indexOf("  /api/v1/resources/{resourceId}/decision:");
  assert.ok(start >= 0, "decision path in openapi");
  const decisionBlock = openapi.slice(start, start + 4000);
  assert.match(decisionBlock, /60\/min/);
  assert.doesNotMatch(decisionBlock, /per-IP window of 10\/min/);

  const paths = readFileSync("src/components/site/home/paths.ts", "utf8");
  assert.match(paths, /keylessDecisionPerMinute\(\)/);
  assert.doesNotMatch(paths, /10 requests/);

  const snippets = readFileSync("src/lib/connect/snippets.ts", "utf8");
  assert.match(snippets, /keylessDecisionPerMinute\(\)/);
  assert.match(snippets, /KEYLESS_DECISION/);
});

test("billing plan monthly limits unchanged", () => {
  assert.equal(BILLING_PLANS.free.monthlyLimit, 1_000);
  assert.equal(BILLING_PLANS.pro.monthlyLimit, 50_000);
  assert.equal(BILLING_PLANS.scale.monthlyLimit, 500_000);
});

test("rendered public copy says 60 for key-less /decision, not 10", async () => {
  const llmsFull = await getLlmsFullTxt().text();
  assert.match(llmsFull, /key-less at 60\/min per IP/);
  assert.doesNotMatch(llmsFull, /key-less at 10\/min per IP/);

  assert.match(DEV_NOTE, /60 requests a minute/);
  assert.doesNotMatch(DEV_NOTE, /10 requests/);

  const snippets = readFileSync("src/lib/connect/snippets.ts", "utf8");
  assert.match(snippets, /KEYLESS_DECISION = keylessDecisionPerMinute\(\)/);
  assert.match(snippets, /\$\{KEYLESS_DECISION\} requests a minute/);
  assert.doesNotMatch(snippets, /10 requests a minute/);

  const page = apiDocsPageText();
  assert.match(page, /answers \{keylessDecisionPerMinute\(\)\} requests per minute per IP/);
  const rateSection = page.slice(page.indexOf('id="rate-limits"'), page.indexOf('id="rate-limits"') + 2500);
  assert.match(rateSection, /\{keylessDecisionPerMinute\(\)\}\/min per IP/);
  const decisionChunks = page.split("/decision");
  for (let i = 1; i < decisionChunks.length; i++) {
    const chunk = decisionChunks[i].slice(0, 400);
    if (/key-less|keyless/i.test(chunk)) {
      assert.doesNotMatch(chunk, /10 requests per minute per IP/i, `docs source chunk ${i}`);
    }
  }
});
// 2026-11-15 依頼主の指摘 1: 9/7 からは 10/分。60/分の「since」は今回の出荷日。静的な文書（llms.txt・openapi）は値から
// 作れないので、値と日付の一致をここで固定する。
test("static docs: the key-less /decision number and its since date follow keyless-limits.ts", async () => {
  const { DECISION_KEYLESS_LIMIT_SINCE } = await import("@/lib/api/keyless-limits");
  const n = keylessDecisionPerMinute();
  assert.equal(DECISION_KEYLESS_LIMIT_SINCE, "2026-11-15");
  const llms =
    readFileSync("public/llms.txt", "utf8") + readFileSync("public/llms-full-prose.txt", "utf8");
  assert.doesNotMatch(llms, /Key-less at \d+\/min per IP since 2026-09-07/, "the 9/7 date belongs to the 10/min window");
  assert.ok(llms.includes(`Key-less since 2026-09-07, at ${n}/min per IP since ${DECISION_KEYLESS_LIMIT_SINCE}`));
  assert.ok(llms.includes(`The decision route below also answers without a key (${n}/min per IP)`));
  const openapi = readFileSync("docs/openapi.yaml", "utf8");
  const block = openapi.slice(openapi.indexOf("  /api/v1/resources/{resourceId}/decision:"));
  assert.ok(block.includes(`per-IP window of ${n}/min\n        (since ${DECISION_KEYLESS_LIMIT_SINCE}, 10/min before)`));
  const page = apiDocsPageText();
  assert.ok(page.includes("since 2026-09-07, at ${keylessDecisionPerMinute()}/min per IP since ${DECISION_KEYLESS_LIMIT_SINCE};"));
  assert.doesNotMatch(page, /\/min per IP with the same body \(since 2026-09-07/);
});

// 2026-11-15 依頼主の指摘 4: 鍵なしは skipScore。score は判定の材料ではないので、score の有無で配る判定は変わらない。
test("the transitional score does not change the decision a key-less caller receives", async () => {
  const { buildDecision, presentDecision } = await import("@/lib/decision/decide");
  const subject = {
    type: "resource" as const,
    id: "r".repeat(64),
    endpoint_id: "e".repeat(64),
    observatory_id: "00000000-0000-0000-0000-000000000001",
    canonical_url: "https://e.com/x",
    method: "GET",
  };
  const base = {
    l0: { status: "pass" as const, observed_at: "2026-09-02T00:00:00Z", dialect: "v2" as const, fail_reason: null },
    l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, n_inconclusive: 0, n_probe_error: 0, p50_ms: 1, p95_ms: 1, last_purchase_id: "eip155:8453:0x1", observed_at: "2026-09-01T00:00:00Z", last_attempt_at: null },
    l2: { status: "conform" as const, declaration_hash: "d", response_hash: "r", diff_hash: null, missing_keys: null, observed_at: "2026-09-01T00:00:00Z" },
    availability_7d: 1,
    availability_30d: 1,
    offer_stability: "stable" as const,
    payees: ["eip155:8453:0xb"],
    settlement_30d_real: 1,
    settlement_30d_raw: 2,
    settlement_30d_test: 0,
    settlement_30d_measurement: 0,
    unique_payers_30d_real: 1,
    wash_dominated: false,
  };
  const now = new Date("2026-09-02T00:00:00Z");
  const variants = [base, { ...base, l0: { ...base.l0, status: "unverified" as const } }, { ...base, l0: { ...base.l0, status: "fail" as const } }];
  for (const facts of variants) {
    const make = (score: { trustScore: number; recommendation: "ALLOW" | "WARN" | "BLOCK" } | null) =>
      presentDecision(
        buildDecision({ role: "payer", subject, facts, options: {}, score, registry: { status: "off", tx_hash: null }, now }),
        { includeScore: false },
      );
    const none = make(null);
    for (const score of [
      { trustScore: 99, recommendation: "ALLOW" as const },
      { trustScore: 5, recommendation: "BLOCK" as const },
    ]) {
      const withScore = make(score);
      assert.deepEqual(
        { ...withScore, scoredAt: "", cacheExpiresAt: "" },
        { ...none, scoredAt: "", cacheExpiresAt: "" },
        `score ${score.recommendation} changed the decision for l0=${facts.l0.status}`,
      );
    }
  }
});

test("the key-less /decision route passes skipScore only for key-less callers", () => {
  const src = readFileSync("src/app/api/v1/resources/[resourceId]/decision/route.ts", "utf8");
  assert.match(src, /\.\.\.\(caller\.kind === "keyless" \? \{ skipScore: true \} : \{\}\)/);
});
