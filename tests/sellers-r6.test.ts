// ============================================================
// 2026-09-29 敵対的監査 6 周目（名指しされた売り手の弁護士・5 周目の修正の確認役）。
//   1 判定の説明文は答えを決めた理由コード別（l0_fail・l1_stale に「not sorted も数える」を書かない）・否定のコードを先に・
//     カードの先頭近く・/docs/api#reason-codes
//   2 「receipt」は売り手の受領証だけ。記録頁・/observatory は「settled on-chain」
//   3 最新の公開 L0 判定が pass でない記録頁は noindex・sitemap にも載らない
//   4 決済が成立していない行は signed / attempted・「vet402 signed:」の重複を消す
//   5 宣言の入力が例示用のドメインの出品の失敗は seller の側に置かない
//   6 旧支払元 0x6777… を方法論に（短い形）
//   7 「After a fix」: 次に買う目安（掃引の窓・冷却・L0）・通知・異議
//   8 /sellers の区分の絞り込み（GET ?side=）
// ============================================================
import { reasonCodeDocOf } from "@/lib/decision/reason-codes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  classifyRow,
  classifySellerRow,
  EXAMPLE_DOMAIN_PATTERN,
  isExampleDomainValue,
  observed402Line,
  sellerCandidateDay,
  type SellerRowFacts,
} from "@/lib/sellers/fix-modes";
import {
  buildSellerBoard,
  buildSellerDetail,
  filterSellersBySide,
  parseSellerSideFilter,
  recordPageNoindex,
  showRow,
  type SellerEndpointFacts,
} from "@/lib/sellers/board";
import {
  recordedLabel,
  SellerDetailView,
  SellersIndexView,
  sellersIndexHref,
  termsLabel,
} from "@/components/site/sellers/SellersViews";
import {
  answerOf,
  codeExplanation,
  COUNTING_NOTE,
  decisionWhy,
  decisiveCodes,
  orderCodes,
  REASON_CODES_HREF,
} from "@/components/site/sellers/DecisionAnswer";
import {
  COOLDOWN_STATUSES,
  MATURE_SETTLED_MIN,
  MATURE_SWEEP_WINDOW_DAYS,
  NON_SETTLING_COOLDOWN_STREAK,
  nextBuyLine,
  nextBuyOf,
  PRIORITY_SELLER_HOSTS,
  PRIORITY_SWEEP_WINDOW_DAYS,
  SWEEP_WINDOW_DAYS,
} from "@/lib/sellers/next-buy";
import { BASE_PAYER_PERIODS, shortPayer } from "@/lib/sellers/payers";
import { PAYER_BALANCE_HISTORY } from "@/lib/observatory/payer-balance-history";
import { L1Ratio } from "@/components/site/Figures";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const TX = `0x${"cd".repeat(32)}`;
const RID = "a".repeat(64);
const FETCHED = "2026-09-29T04:10:00.000Z";

function row(p: Partial<SellerRowFacts>): SellerRowFacts {
  return {
    endpointId: "e1",
    status: "settle_failed",
    httpStatusPaid: null,
    txHash: null,
    attemptedAt: "2026-09-20T12:00:00Z",
    network: "eip155:8453",
    method: "GET",
    meta: null,
    schema: null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    ...p,
  };
}

/** (b)〜(e) を満たす（seller の側の候補になる）行。 */
function proven(p: Partial<SellerRowFacts>): SellerRowFacts {
  return row({
    amountUnits: "10000",
    payTo: `0x${"11".repeat(20)}`,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    declaresHeaders: false,
    pathTemplate: false,
    listingMaxTimeoutSeconds: 20,
    meta: { requestBody: "none", requestQuery: "empty" },
    ...p,
  });
}

const ep = (id: string, over: Partial<SellerEndpointFacts> = {}): SellerEndpointFacts => ({
  endpointId: id,
  resourceKey: `s.example/${id}`,
  resourceUrl: `https://s.example/${id}`,
  method: "GET",
  priceAmount: "10000",
  resourceId: RID,
  ...over,
});

// ---------------------------------------------------------------- 1

test("1: 説明文は答えを決めたコード別で、理由コードの表（reason-codes.ts）の meaning そのもの。l0_fail・l1_stale に数え方の文を付けない", () => {
  const meaning = (c: string) => reasonCodeDocOf(c)!.meaning;
  const l0 = answerOf({
    recommendation: "BLOCK",
    reason_codes: ["l0_fail", "l1_delivered", "l2_undeclared"],
    facts: { l0: { fail_reason: "no_402" } },
  })!;
  assert.deepEqual(l0.decisive, ["l0_fail"]);
  const whyL0 = decisionWhy(l0, false);
  assert.deepEqual(whyL0, [`${meaning("l0_fail")} (reason no_402)`]);
  assert.ok(!whyL0.includes(COUNTING_NOTE), "l0_fail には数え方の違いを書かない（keyring-agent…/swap-token 型）");

  const stale = answerOf({
    recommendation: "WARN",
    reason_codes: ["l0_pass", "l1_delivered", "l1_stale", "l2_undeclared"],
    l1_basis: { fresh_days: 30, window_days: 30, days_since_last_delivery: 44.6, last_delivered_at: "2026-08-15T00:00:00Z", n_counted: 1, n_paid_undelivered_since_last_delivery: 0 },
  })!;
  assert.deepEqual(stale.reasonCodes.slice(0, 1), ["l1_stale"], "答えを決めた否定のコードが先頭（l0_pass・l1_delivered より前）");
  assert.deepEqual(decisionWhy(stale, false), [`${meaning("l1_stale")} (last delivery 44 days ago)`], "agentdata…/crypto/scan 型");

  const never = answerOf({
    recommendation: "WARN",
    reason_codes: ["l0_pass", "l1_never_delivered", "l2_undeclared"],
    l1_basis: { n_counted: 3, n_paid_undelivered_since_last_delivery: 0 },
  })!;
  const neverLine = `${meaning("l1_never_delivered")} (3 counted paid attempts)`;
  assert.deepEqual(decisionWhy(never, false), [neverLine, COUNTING_NOTE]);
  assert.deepEqual(decisionWhy(never, true), [neverLine], "売り手の側に置いた出品には数え方の違いを書かない");
  assert.equal(COUNTING_NOTE, reasonCodeDocOf("l1_not_counted_unproven")!.forPayer, "数え方の文も表から");
  // 2026-09-29.4: BLOCK を決めるのは売り手の側（確定）の l1_paid_not_delivered 2 回以上（rules.ts blockReasonCodes）。
  const paidTwice = answerOf({
    recommendation: "BLOCK",
    reason_codes: ["l0_pass", "l1_never_delivered", "l1_paid_not_delivered", "l2_undeclared"],
    l1_basis: { n_counted: 3, n_paid_undelivered_since_last_delivery: 2, n_paid_undelivered_seller_side_since_last_delivery: 2 },
  })!;
  assert.deepEqual(paidTwice.decisive, ["l1_paid_not_delivered"], "l1_never_delivered は BLOCK を決めない");
  assert.deepEqual(decisiveCodes("BLOCK", ["l0_fail", "l1_delivered", "l2_mismatch", "l2_mismatch_unexplained"]), ["l0_fail"]);
  const unexplained = answerOf({ recommendation: "WARN", reason_codes: ["l0_pass", "l1_delivered", "l2_mismatch", "l2_mismatch_unexplained"], facts: { l2: { missing_keys: [] } } })!;
  assert.deepEqual(decisionWhy(unexplained, false), [meaning("l2_mismatch"), meaning("l2_mismatch_unexplained")]);

  const l2 = answerOf({ recommendation: "BLOCK", reason_codes: ["l0_pass", "l1_delivered", "l2_mismatch"], facts: { l2: { missing_keys: ["price", "sku"] } } })!;
  assert.deepEqual(decisionWhy(l2, false), [`${meaning("l2_mismatch")} (missing: price, sku)`]);
  assert.deepEqual(decisionWhy(answerOf({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"] })!, false), []);
});

test("1: BLOCK を決めたコードと WARN だけのコードを分ける（l1_paid_not_delivered は売り手の側 2 回で BLOCK・それ以外は WARN の事由）", () => {
  const codes = ["l0_pass", "l1_delivered", "l1_paid_not_delivered", "l1_latest_failed", "l2_mismatch", "l2_undeclared"];
  const basis = { freshDays: 30, windowDays: 30, nCounted: 4, nPaidUndeliveredSince: 3, nPaidUndeliveredSellerSince: 1, daysSinceLastDelivery: 2, lastDeliveredAt: "x" };
  assert.deepEqual(decisiveCodes("BLOCK", codes, basis), ["l2_mismatch"]);
  assert.deepEqual(orderCodes("BLOCK", codes, basis), ["l2_mismatch", "l1_paid_not_delivered", "l1_latest_failed", "l0_pass", "l1_delivered", "l2_undeclared"]);
  // L0 の unverified は WARN（BLOCK を決めない）。原因のコードは l0_unverified の直後。
  const single = ["l0_unverified", "l0_unverified_single_fail", "l1_delivered", "l2_undeclared"];
  assert.deepEqual(orderCodes("WARN", single), single);
  assert.equal(
    codeExplanation("l0_unverified", { reasonCodes: single, basis: null, l2MissingKeys: null, l0FailReason: null }),
    `${reasonCodeDocOf("l0_unverified")!.meaning} (cause single_fail)`,
  );
  assert.equal(codeExplanation("l1_waived_by_operator", { reasonCodes: [], basis: null, l2MissingKeys: null, l0FailReason: null }), null, "判定を動かさない語は書かない");
});

test("1: 判定の答えはカードの先頭近く（What we saw より前）で、理由コードの説明へリンクする", () => {
  const rows = [proven({ endpointId: "e1", status: "settle_failed", httpStatusPaid: 500 })];
  const d = buildSellerDetail("s.example", [ep("e1")], rows, FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  const decision = html.indexOf("Decision API now:");
  const saw = html.indexOf("What we saw:");
  assert.ok(decision > 0 && saw > 0 && decision < saw, "判定の行が What we saw より前");
  assert.equal(REASON_CODES_HREF, "/docs/api#reason-codes");
  assert.match(html, /href="\/docs\/api#reason-codes"/);
  const src = read("src/components/site/sellers/DecisionAnswer.tsx");
  // 2026-09-29 監査 7 周目: 説明と BLOCK の語は正典（純関数の reason-codes.ts・rules.ts）から読む。支払いに届く
  // seller-facts.ts・decide.ts は import しない（tests/sellers-no-payment-imports.test.ts が頁のバンドルを見る）。
  assert.doesNotMatch(src, /from "@\/lib\/decision\/(seller-facts|decide)"/, "判定の組み立て（DB・支払い）を import しない");
  assert.match(src, /from "@\/lib\/decision\/reason-codes"/);
});

// ---------------------------------------------------------------- 2

test("2: 記録頁・/observatory・L1 の比の title は「settled on-chain」。receipt は売り手の受領証の意味だけ", () => {
  const record = read("src/app/observatory/e/[id]/page.tsx");
  assert.doesNotMatch(record, /settled with a receipt|settled with an on-chain receipt|Receipt \(tx\)/);
  assert.match(record, /paid attempts settled on-chain, and/);
  const obs = read("src/app/observatory/page.tsx");
  assert.doesNotMatch(obs, /\[receipts|Receipts count|L0 and L1 receipts|keeps only rows with a receipt/);
  assert.match(obs, /\[settled on-chain /);
  const html = renderToStaticMarkup(createElement(L1Ratio, { settled: 2, attempts: 3, delivered: 1 }));
  assert.match(html, /2 settled on-chain of 3 paid attempts/);
  assert.doesNotMatch(html, /with a receipt/);
});

// ---------------------------------------------------------------- 3

test("3: 最新の公開 L0 判定が pass でない記録頁は noindex（届かなかった行・読めない場合と同じ）", () => {
  const none = { undelivered: 0 };
  assert.equal(recordPageNoindex("pass", none), false);
  assert.equal(recordPageNoindex("fail", none), true);
  assert.equal(recordPageNoindex("unverified", none), true);
  assert.equal(recordPageNoindex(null, none), true);
  assert.equal(recordPageNoindex("pass", { undelivered: 1 }), true);
  assert.equal(recordPageNoindex("pass", null), true);
  // sitemap は最新のプローブが pass の出品だけ（publishedVerdict の pass と同じ条件）
  const reader = read("src/lib/observatory/reader.ts");
  const fn = reader.slice(reader.indexOf("export async function getSitemapEndpoints"), reader.indexOf("export async function getSitemapEndpoints") + 1500);
  assert.match(fn, /AND \(lp\.verdicts\)\[1\] = 'pass'/);
});

// ---------------------------------------------------------------- 4

test("4: 決済が成立していない行は signed、署名していない行は attempt。「vet402 signed:」を重ねない", () => {
  const unsettled = showRow(proven({ status: "settle_failed", httpStatusPaid: 500 }));
  assert.equal(recordedLabel(unsettled), "Recorded (L1 attempt; vet402 signed a payment, not settled on-chain)");
  const settled = showRow(proven({ status: "settled", httpStatusPaid: 500, txHash: TX }));
  assert.equal(recordedLabel(settled), "Recorded (L1 paid purchase)");
  assert.equal(recordedLabel(showRow(row({ status: "no_eligible_accept", network: null }))), "Recorded (attempt; vet402 did not pay, not an L1 result)");
  const line = `${termsLabel(unsettled)} ${unsettled.seen402}`;
  assert.match(line, /^The 402 terms vet402 signed: exact · /);
  assert.doesNotMatch(line, /vet402 signed: vet402 signed/);
  assert.doesNotMatch(observed402Line(proven({})) ?? "", /^vet402 signed:/);

  // 最新が vet402 の側（tx なし）のとき「has not bought this listing again」と書かない
  const rows = [
    proven({ endpointId: "e1", status: "settled", httpStatusPaid: 200, txHash: TX, attemptedAt: "2026-09-04T00:00:00Z" }),
    row({ endpointId: "e1", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T01:00:00Z" }),
  ];
  const d = buildSellerDetail("s.example", [ep("e1")], rows, FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  assert.doesNotMatch(html, /has not bought (this listing|it) again/);
  assert.match(html, /there has been no attempt since\./);
});

// ---------------------------------------------------------------- 5

test("5: 例示用のドメイン（値の全体）を当て、説明文の中の言及は当てない。JS と Postgres で同じ式", () => {
  for (const v of ["https://example.com", "example.com", "https://api.example.com/v1/x?y=1", "jane@example.com", "http://example.org:8080/a", "EXAMPLE.NET", "https://seller.example/api/route", "your-agent.example"]) {
    assert.equal(isExampleDomainValue(v), true, v);
  }
  for (const v of ["for example https://example.com", "https://example.co.uk", "https://myexample.com", "https://example.company.io", "github.com", "Defaults to https://example.com if you leave it out.", 42, null]) {
    assert.equal(isExampleDomainValue(v), false, String(v));
  }
  // Postgres の ARE でも読める形（後読み・名前付きの組を使わない）
  assert.doesNotMatch(EXAMPLE_DOMAIN_PATTERN, /\(\?<|\(\?=|\(\?!/);
  const reader = read("src/lib/sellers/reader.ts");
  assert.match(reader, /~\* \$\{EXAMPLE_DOMAIN_PATTERN\}/);
  assert.match(reader, /\$\{EXAMPLE_INPUT\} AS example_input/);
});

test("5: 宣言の入力が例示用のドメインなら seller の側に置かない（公開頁の層だけ・判定 API の classifyRow は変えない）", () => {
  const a = proven({ status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T12:00:00Z", exampleInput: true });
  const b = proven({ status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-22T12:00:00Z", exampleInput: true });
  assert.equal(classifyRow(a).bucket, "seller", "判定 API の分類は変えない");
  const c = classifySellerRow(a, { sellerFailureDays: ["2026-09-20", "2026-09-22"] });
  assert.equal(c.bucket, "unsorted");
  assert.equal(c.mode?.key, "example_input");
  assert.equal(c.confirmedSeller, false);
  assert.equal(sellerCandidateDay(b), null, "2 回確定の材料にもならない");
  const plain = classifySellerRow({ ...a, exampleInput: false }, { sellerFailureDays: ["2026-09-20", "2026-09-22"] });
  assert.equal(plain.bucket, "seller");
});

// ---------------------------------------------------------------- 6

test("6: 方法論に Base の支払元を短い形で（旧 0x6777… の期間つき）。アドレスは残高の定義から引く", () => {
  const known = new Set(PAYER_BALANCE_HISTORY.map((p) => p.payer));
  for (const p of BASE_PAYER_PERIODS) assert.ok(known.has(p.address), p.address);
  assert.equal(shortPayer(BASE_PAYER_PERIODS[0].address), "0x6777…3986");
  assert.equal(BASE_PAYER_PERIODS[0].until, "2026-09-04");
  const m = read("src/app/observatory/methodology/page.tsx");
  assert.match(m, /BASE_PAYER_PERIODS\.map/);
  assert.match(m, /shortPayer\(p\.address\)/);
  assert.doesNotMatch(m, /0x6777e11f/i, "完全なアドレスは方法論の本文に書かない");
});

// ---------------------------------------------------------------- 7

test("7: 次に買う目安の定数は l1-runner の値と同じ（/sellers は l1-runner を import できないので写し）", async () => {
  const runner = await import("@/lib/observatory/l1-runner");
  assert.equal(SWEEP_WINDOW_DAYS, runner.SWEEP_WINDOW_DAYS);
  assert.equal(PRIORITY_SWEEP_WINDOW_DAYS, runner.PRIORITY_SWEEP_WINDOW_DAYS);
  assert.equal(MATURE_SWEEP_WINDOW_DAYS, runner.MATURE_SWEEP_WINDOW_DAYS);
  assert.equal(MATURE_SETTLED_MIN, runner.MATURE_SETTLED_MIN);
  assert.equal(NON_SETTLING_COOLDOWN_STREAK, runner.NON_SETTLING_COOLDOWN_STREAK);
  assert.deepEqual([...PRIORITY_SELLER_HOSTS], [...runner.PRIORITY_SELLER_HOSTS]);
  // 冷却の status の並びは候補 SQL と同じ
  const src = read("src/lib/observatory/l1-runner.ts");
  const at = src.indexOf("LIMIT ${NON_SETTLING_COOLDOWN_STREAK}");
  const block = src.slice(src.lastIndexOf("AND pu.status IN (", at), at);
  const inSql = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(inSql, [...COOLDOWN_STATUSES]);
});

test("7: 目安の計算（窓・優先・成熟・冷却・L0・形）。計算できなければ書かない", () => {
  const base = { resourceKey: "s.example/a", resourceUrl: "https://s.example/a" };
  const NOW = Date.parse("2026-09-21T00:00:00Z");
  const w = nextBuyOf(base, { lastAttemptAnyAt: "2026-09-20T12:00:00Z", settledCount: 1, cooldown: false, latestL0Verdict: "pass" }, NOW);
  assert.deepEqual(w, { kind: "window", notBefore: "2026-09-26 12:00 UTC", windowDays: 6, basis: "default", l0: "pass", open: false });
  assert.match(nextBuyLine(w) ?? "", /^Not before 2026-09-26 12:00 UTC \(a listing is bought at most once every 6 days\)\. .*earliest date, not a booking\.$/);
  // 窓が明けた後は過去の日付を「Not before」と書かない
  const past = nextBuyOf(base, { lastAttemptAnyAt: "2026-09-20T12:00:00Z", settledCount: 1, cooldown: false, latestL0Verdict: "pass" }, Date.parse("2026-09-29T00:00:00Z"));
  assert.match(nextBuyLine(past) ?? "", /^The regular sweep can pick this listing again since 2026-09-26 12:00 UTC /);
  const mature = nextBuyOf(base, { lastAttemptAnyAt: "2026-09-20T12:00:00Z", settledCount: 3, cooldown: false, latestL0Verdict: "fail" }, NOW);
  assert.equal(mature?.kind === "window" && mature.notBefore, "2026-10-20 12:00 UTC");
  assert.match(nextBuyLine(mature) ?? "", /latest one reads fail\./);
  const prio = nextBuyOf({ resourceKey: "api.exa.ai/search", resourceUrl: "https://api.exa.ai/search" }, { lastAttemptAnyAt: "2026-09-20T12:00:00Z", settledCount: 9, cooldown: false, latestL0Verdict: "pass" }, NOW);
  assert.equal(prio?.kind === "window" && prio.windowDays, 1);
  assert.deepEqual(nextBuyOf(base, { lastAttemptAnyAt: "2026-09-20T12:00:00Z", settledCount: 0, cooldown: true, latestL0Verdict: "pass" }), { kind: "cooldown" });
  assert.deepEqual(nextBuyOf({ resourceKey: "s.example/:id", resourceUrl: "https://s.example/:id" }, null), { kind: "not_bought", reason: "path_template" });
  assert.deepEqual(nextBuyOf({ resourceKey: "s.example/a", resourceUrl: "http://s.example/a" }, null), { kind: "not_bought", reason: "not_https" });
  assert.equal(nextBuyOf(base, null), null, "材料が無ければ書かない");
  assert.equal(nextBuyOf(base, { lastAttemptAnyAt: null, settledCount: 0, cooldown: false, latestL0Verdict: "pass" }), null);
});

test("7: 「After a fix」の 1 ブロックに、次の購入の目安・通知の登録・異議がまとまる", () => {
  const rows = [proven({ endpointId: "e1", status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-20T12:00:00Z" })];
  const d = buildSellerDetail(
    "s.example",
    [ep("e1", { nextBuyFacts: { lastAttemptAnyAt: "2026-09-27T12:00:00Z", settledCount: 0, cooldown: false, latestL0Verdict: "pass" } })],
    rows,
    FETCHED,
  );
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  const block = html.slice(html.indexOf('aria-label="After a fix"'));
  assert.ok(block.length > 0);
  const end = block.indexOf("</div>");
  const inner = block.slice(0, end);
  assert.match(inner, /Next purchase by vet402:<\/strong> Not before 2026-10-03 12:00 UTC/);
  assert.match(inner, /Email me when this result changes/);
  assert.match(inner, /Dispute this purchase/);
});

// ---------------------------------------------------------------- 8

test("8: /sellers の区分の絞り込み（?side=）。知らない値は全部・頁送りは区分を持ち越す", () => {
  assert.equal(parseSellerSideFilter("seller"), "seller");
  assert.equal(parseSellerSideFilter(["unsorted", "x"]), "unsorted");
  assert.equal(parseSellerSideFilter("pending"), null);
  assert.equal(parseSellerSideFilter(undefined), null);
  const board = buildSellerBoard(
    [
      { host: "a.example", listings: 1 },
      { host: "b.example", listings: 1 },
    ],
    [
      { ...proven({ endpointId: "a1", status: "settled", httpStatusPaid: 200, txHash: TX }), host: "a.example" },
      { ...row({ endpointId: "b1", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-09-14T01:00:00Z" }), host: "b.example" },
    ],
    FETCHED,
  );
  assert.deepEqual(filterSellersBySide(board.sellers, "delivered").map((s) => s.host), ["a.example"]);
  assert.deepEqual(filterSellersBySide(board.sellers, "vet402").map((s) => s.host), ["b.example"]);
  assert.equal(filterSellersBySide(board.sellers, null).length, 2);
  assert.equal(sellersIndexHref("seller", 2), "/sellers?side=seller&page=2");
  assert.equal(sellersIndexHref(null, 1), "/sellers");
  const html = renderToStaticMarkup(createElement(SellersIndexView, { board, page: 1, q: "", search: null, revalidateSec: 300, side: "delivered" }));
  assert.match(html, /Showing 1 of 2 sellers/);
  assert.match(html, /href="\/sellers\?side=vet402"/);
  assert.match(html, /aria-current="page"[^>]*>Delivered \(1\)/);
  const table = html.slice(html.indexOf("most recent purchase first"));
  assert.match(table, /a\.example/);
  assert.doesNotMatch(table, /b\.example/);
});
