// ============================================================
// pay.sh カタログ配達一覧（pay-skills-listings.ts・2026-11-24）。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAY_SKILLS_LISTINGS,
  PAY_SKILLS_LISTINGS_FILE,
  PAY_SKILLS_SOURCE,
  parsePaySkillsListings,
  paySkillsFetchResult,
  paySkillsExampleBody,
} from "@/lib/observatory/pay-skills-listings";
import { PAYSH_PINNED_PURCHASES } from "@/lib/observatory/pay-skills-pinned-data";
import { PINNED_PURCHASES, pinnedPurchaseMetaOf } from "@/lib/observatory/pinned-purchases";
import { feedListedIn, LISTED_IN_CASE_SQL } from "@/lib/delivery/listed-in";
import { parseDeliverySellersQuery } from "@/lib/delivery/sellers-feed-query";
import { selectPaidRequestBody } from "@/lib/observatory/declared-input-rules";
import { SOLANA_DAILY_CAP_USD_DEFAULT, solanaDailyCapUnits } from "@/lib/observatory/budget";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";

const ROOT = process.cwd();
const EXCLUDED_CSV = "/Users/takeshi/Takeshi_Automation/output/1124/moat/paysh_excluded.csv";

test("一覧は規則どおりに読め、件数が purchase_plan の残りと一致する", () => {
  const items = parsePaySkillsListings(PAY_SKILLS_LISTINGS);
  assert.equal(items.length, PAY_SKILLS_LISTINGS.length);
  assert.equal(PAYSH_PINNED_PURCHASES.length, PAY_SKILLS_LISTINGS.length);
  assert.equal(items.length, 344);
  assert.equal(PAY_SKILLS_SOURCE, "pay_skills");
  assert.ok(readFileSync(join(ROOT, PAY_SKILLS_LISTINGS_FILE), "utf8").includes("export const PAY_SKILLS_LISTINGS"));
});

test("catalogOrder は CSV の order 順（昇順）", () => {
  let prev = 0;
  for (const row of PAY_SKILLS_LISTINGS) {
    assert.ok(row.catalogOrder > prev, `order not increasing at ${row.url}`);
    prev = row.catalogOrder;
  }
});

test("除外規則: 残す読み取り系（3件）は一覧に含まれる", () => {
  const urls = PAY_SKILLS_LISTINGS.map((l) => l.url);
  assert.ok(urls.some((u) => u.includes("/v4/wallets/top-traders")), "vybe top-traders");
  assert.ok(urls.some((u) => u.includes("/x402/token/v1/transfer/total")), "birdeye transfer/total");
  assert.ok(urls.some((u) => u.includes("/v4/wallets/batch/token-balances")), "vybe batch token-balances");
});

test("除外規則: 変更系（3件）は paysh_excluded に載る", () => {
  const ex = readFileSync(EXCLUDED_CSV, "utf8");
  assert.ok(ex.includes("/v4/wallets/util/close-token-accounts") && ex.includes("keyword:close-"), "close-token-accounts");
  assert.ok(ex.includes("/v4/wallets/util/withdraw-mev") && ex.includes("keyword:withdraw"), "withdraw-mev");
  assert.ok(ex.includes("/api/book") && ex.includes("keyword:book"), "book");
  assert.ok(ex.includes("createTask") && ex.includes("keyword:create"), "create");
  assert.ok(ex.includes("agentmail/email") && ex.includes("/v0/pods") && ex.includes("keyword:email"), "agentmail pods");
});

test("FactGate の予約は先頭のまま（weather-forecast）", () => {
  assert.ok(PINNED_PURCHASES[0]!.url.includes("weather-forecast"));
  assert.ok(PINNED_PURCHASES[0]!.reason.includes("FactGate"));
  const presign = PINNED_PURCHASES.find((p) => p.reason === "presign-gate-2611");
  assert.ok(presign);
  assert.deepEqual(pinnedPurchaseMetaOf(presign!).pinnedPurchaseReason, "presign-gate-2611");
  assert.equal(presign!.approvedAt, "2026-11-23T23:25:00.000Z");
  assert.equal(presign!.requestedBy, "solana-paysh special session (pay.sh catalog delivery report)");
});

test("Solana 別枠: 一覧の先頭だけを買っても $2 を超えない（quoted 合計の検算）", () => {
  assert.equal(SOLANA_DAILY_CAP_USD_DEFAULT, 2);
  const cap = solanaDailyCapUnits();
  let spent = 0n;
  let n = 0;
  for (const row of PAY_SKILLS_LISTINGS) {
    if (row.network !== SOLANA_MAINNET_CAIP2) continue;
    const next = spent + BigInt(row.amount);
    if (next > cap) break;
    spent = next;
    n++;
  }
  assert.ok(n >= 1);
  assert.ok(spent <= cap);
});

test("取得は常に完全・listed_in pay_skills", () => {
  const result = paySkillsFetchResult();
  assert.equal(result.complete, true);
  assert.equal(feedListedIn(PAY_SKILLS_SOURCE), "pay_skills");
  assert.match(LISTED_IN_CASE_SQL, /WHEN 'pay_skills' THEN 'pay_skills'/);
  const q = parseDeliverySellersQuery(new URLSearchParams("listed_in=pay_skills"));
  assert.notEqual(q, "invalid");
  assert.equal(q.listedIn, "pay_skills");
});

test("POST 本文: pay_skills_example は operator の次", () => {
  const empty = { body: "{}", source: "empty" as const };
  const example = '{"q":1}';
  assert.deepEqual(selectPaidRequestBody({ declared: empty, operatorExample: null, paySkillsExample: example }), {
    body: example,
    source: "pay_skills_example",
  });
  const firstPost = PAY_SKILLS_LISTINGS.find((l) => l.method === "POST");
  assert.ok(firstPost);
  assert.notEqual(paySkillsExampleBody(firstPost!.url), null);
});

test("同期は catalog-sync-aux に載る", () => {
  const route = readFileSync(join(ROOT, "src/app/api/cron/catalog-sync-aux/route.ts"), "utf8");
  assert.ok(route.includes("await syncPaySkillsListings()"));
  const openapi = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");
  assert.ok(openapi.includes("enum: [bazaar, circle, mpp, operator, pay_skills]"));
});