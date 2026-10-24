// 取り下げた経路（カタログ status delisted）は公開の fail に数えない。
// DB が無いときは純関数とソースの結線だけを見る。DB 付きの数え方は
// tests/observatory-reader.test.ts の "a delisted fail streak is withdrawn"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assembleSellerFacts } from "@/lib/decision/seller-facts";
import { decidePayer } from "@/lib/decision/rules";
import { parseRegistry } from "@/lib/claims/yaml";
import {
  L0_CSV_WITHDRAWAL_READING,
  NONSETTLED_PAID_ATTEMPT_STATUSES,
  WITHDRAWN_FROM_CATALOG,
  catalogWithdrawalCorrectionAction,
  publicProbeWord,
  purchaseShownAsWithdrawn,
  tallyProbeWords,
  withdrawnAbbrTitle,
  withdrawnBandCountSentence,
  withdrawnChainNote,
  withdrawnFromCatalogSentence,
  withdrawnL0FailNote,
  withdrawnRoutesHeading,
  withdrawnRoutesParagraph,
  withdrawnStateLabel,
} from "@/lib/observatory/l0-verdict";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";

const read = (p: string) => readFileSync(p, "utf8");

test("取り下げた経路は fail に数えない", () => {
  const tally = tallyProbeWords([
    { status: "delisted", verdicts: ["fail", "fail"] },
    { status: "active", verdicts: ["fail", "fail"] },
  ]);
  assert.equal(tally.fail, 1);
  assert.equal(tally.withdrawn, 1);
  assert.equal(publicProbeWord("delisted", ["pass"]), "pass");
  assert.equal(publicProbeWord("active", ["fail"]), "unverified");
  assert.equal(publicProbeWord("delisted", ["fail"]), "unverified");
  assert.equal(purchaseShownAsWithdrawn("delisted", "settle_failed"), true);
  assert.equal(purchaseShownAsWithdrawn("delisted", "settled"), false);
  assert.equal(purchaseShownAsWithdrawn("active", "settle_failed"), false);
  const sentence = withdrawnFromCatalogSentence();
  assert.match(sentence, /public L0 fail count/);
  assert.doesNotMatch(sentence, /\bL1\b/);
  assert.doesNotMatch(sentence, /by the seller/i);
  assert.doesNotMatch(sentence, /\b(we|our|us)\b/i);
  assert.doesNotMatch(sentence, /;/);
  assert.doesNotMatch(sentence, /—|–|--/);
});

test("withdrawn の公開文は L1 を言わず、by the seller を出さない", () => {
  const copies = [
    withdrawnFromCatalogSentence(),
    withdrawnL0FailNote(),
    withdrawnRoutesHeading(),
    withdrawnRoutesParagraph(),
    withdrawnStateLabel(),
    withdrawnChainNote(),
    withdrawnAbbrTitle(),
    WITHDRAWN_FROM_CATALOG,
    withdrawnBandCountSentence(4893),
    catalogWithdrawalCorrectionAction(),
  ];
  const html = renderToStaticMarkup(createElement("div", null, copies.join(" ")));
  assert.doesNotMatch(html, /\bL1\b/);
  assert.doesNotMatch(html, /by the seller/i);
  assert.match(html, /public L0 fail count/);
  assert.match(html, /withdrawn from the catalog/i);
});

test("withdrawn の文は claims.yaml に、関数の戻り値そのもので登録されている", () => {
  const claim = parseRegistry(read("docs/claims.yaml")).claims.find((row) => row.id === "withdrawn_left_out_of_public_l0_fail");
  assert.ok(claim);
  assert.equal(claim.surface, "src/lib/observatory/l0-verdict.ts");
  assert.equal(claim.quote, withdrawnFromCatalogSentence());
  assert.doesNotMatch(claim.quote, /\bL1\b/);
  assert.doesNotMatch(claim.quote, /by the seller/i);
});

test("掲載から外れた経路でも /decision は2回連続の L0 fail で BLOCK のまま", () => {
  assert.equal(publicProbeWord("delisted", ["fail", "fail"]), "withdrawn");
  assert.equal(publicProbeWord("active", ["fail", "fail"]), "fail");
  const now = new Date("2026-10-24T00:00:00Z");
  const probes = [0, 1].map((d) => ({
    probedAt: new Date(now.getTime() - d * 86_400_000).toISOString(),
    verdict: "fail",
    dialect: "v2",
    failReason: "no_402",
    priceAmount: null,
    priceAsset: null,
    payTo: null,
  }));
  const facts = assembleSellerFacts({
    probes,
    purchases: [],
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: [],
    declaredSchema: null,
    method: "GET",
    declaredInput: null,
    lastAttemptAt: null,
  });
  assert.equal(facts.l0.status, "fail");
  const decision = decidePayer(facts, { now });
  assert.equal(decision.recommendation, "BLOCK");
  assert.ok(decision.reason_codes.includes("l0_fail"));
  const action = catalogWithdrawalCorrectionAction();
  assert.ok(action.includes(L0_CSV_WITHDRAWAL_READING.retrievedAt));
  assert.ok(action.includes(L0_CSV_WITHDRAWAL_READING.publishedVerdictFail.toLocaleString("en-US")));
  assert.ok(action.includes(L0_CSV_WITHDRAWAL_READING.listedFail.toLocaleString("en-US")));
  assert.ok(action.includes(L0_CSV_WITHDRAWAL_READING.notListedFail.toLocaleString("en-US")));
  assert.match(action, /BLOCK/);
  assert.equal(L0_CSV_WITHDRAWAL_READING.listedFail + L0_CSV_WITHDRAWAL_READING.notListedFail, L0_CSV_WITHDRAWAL_READING.publishedVerdictFail);
});

test("未決済の支払い試行の集合は PAID_ATTEMPT_STATUSES から settled を除いたもの", () => {
  assert.deepEqual(
    [...NONSETTLED_PAID_ATTEMPT_STATUSES].sort(),
    PAID_ATTEMPT_STATUSES.filter((s) => s !== "settled").sort(),
  );
});

test("記録ページに withdrawn と出る", () => {
  const page = read("src/app/observatory/e/[id]/page.tsx");
  assert.match(page, /withdrawnFromCatalogSentence\(\)/);
  assert.match(page, /publishedVerdict === "withdrawn"/);
  assert.match(page, /purchaseShownAsWithdrawn/);
  assert.match(page, /withdrawnL0FailNote\(\)/);
  assert.doesNotMatch(page, /by the seller/i);
});

test("state の fail 集計は delisted を分け、画面と訂正ログが withdrawnFail を出す", () => {
  const reader = read("src/lib/observatory/reader.ts");
  const failAt = reader.indexOf("::int AS published_fail");
  assert.match(reader.slice(failAt - 500, failAt), /status <> 'delisted'/);
  assert.match(reader, /status = 'delisted'/);
  assert.match(reader, /AS withdrawn_fail/);
  const state = read("src/app/observatory/state/page.tsx");
  assert.match(state, /withdrawnFail/);
  assert.match(state, /withdrawnStateLabel\(\)/);
  assert.match(state, /withdrawnChainNote\(\)/);
  assert.match(state, /withdrawnAbbrTitle\(\)/);
  const corrections = read("src/app/corrections/page.tsx");
  assert.match(corrections, /2026-10-24/);
  assert.match(corrections, /catalogWithdrawalCorrectionAction\(\)/);
  const sellers = read("src/components/site/sellers/SellersViews.tsx");
  assert.match(sellers, /withdrawnRoutesParagraph\(\)/);
  assert.match(sellers, /withdrawnL0FailNote\(\)/);
  assert.doesNotMatch(sellers, /by the seller/i);
});
