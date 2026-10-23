// 取り下げた経路（カタログ status delisted）は公開の fail に数えない。
// DB が無いときは純関数とソースの結線だけを見る。DB 付きの数え方は
// tests/observatory-reader.test.ts の "a delisted fail streak is withdrawn"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NONSETTLED_PAID_ATTEMPT_STATUSES,
  publicProbeWord,
  purchaseShownAsWithdrawn,
  tallyProbeWords,
  withdrawnBySellerSentence,
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
  const sentence = withdrawnBySellerSentence();
  assert.match(sentence, /withdrawn by the seller/i);
  assert.doesNotMatch(sentence, /\b(we|our|us)\b/i);
  assert.doesNotMatch(sentence, /;/);
  assert.doesNotMatch(sentence, /—|–|--/);
});

test("未決済の支払い試行の集合は PAID_ATTEMPT_STATUSES から settled を除いたもの", () => {
  assert.deepEqual(
    [...NONSETTLED_PAID_ATTEMPT_STATUSES].sort(),
    PAID_ATTEMPT_STATUSES.filter((s) => s !== "settled").sort(),
  );
});

test("記録ページに withdrawn と出る", () => {
  const page = read("src/app/observatory/e/[id]/page.tsx");
  assert.match(page, /withdrawnBySellerSentence\(\)/);
  assert.match(page, /publishedVerdict === "withdrawn"/);
  assert.match(page, /purchaseShownAsWithdrawn/);
  assert.match(page, /withdrawn by the seller/);
});

test("state の fail 集計は delisted を分け、画面と訂正ログが withdrawnFail を出す", () => {
  const reader = read("src/lib/observatory/reader.ts");
  const failAt = reader.indexOf("::int AS published_fail");
  assert.match(reader.slice(failAt - 500, failAt), /status <> 'delisted'/);
  assert.match(reader, /status = 'delisted'/);
  assert.match(reader, /AS withdrawn_fail/);
  const state = read("src/app/observatory/state/page.tsx");
  assert.match(state, /withdrawnFail/);
  assert.match(state, /Withdrawn by the seller/);
  const corrections = read("src/app/corrections/page.tsx");
  assert.match(corrections, /2026-10-24/);
  assert.match(corrections, /withdrawn by the seller/);
  const sellers = read("src/components/site/sellers/SellersViews.tsx");
  assert.match(sellers, /withdrawn by the seller/);
  assert.match(sellers, /withdrawnBySellerSentence\(\)/);
});
