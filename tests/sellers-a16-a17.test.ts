// ============================================================
// 2026-10-21 A-16・A-17（Grok 監査: 個人開発の売り手・調達担当）。
//   A-16 失敗のカードは平易な 3 文で始める（何が起きたか・どちらの側か・売り手にできることと次の購入の時期）。
//        遅延回収の待ちの 5xx を「まだ失敗ではない」と読ませない（Result に HTTP の値）。見直しに期限を作らない
//        （無いと書く）。異議は購入を始めないと、売り手頁の After a fix と記録頁の異議欄に書く。
//   A-17 帰属が見直し中であることを、一覧（/sellers・/sellers/fix-first）と sellers の CSV でも言う。
//        CSV のライセンス（CC BY）は変えない（ライセンスの変更はオーナーの判断）。
// 古い文面が戻ったら落ちる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sideFromWords } from "@/lib/surface-canary/parse";
import { ATTRIBUTION_REVIEW_NOTE, ATTRIBUTION_UNDER_REVIEW, sellerCandidateDay, type SellerRowFacts } from "@/lib/sellers/fix-modes";
import { buildSellerBoard, buildSellerDetail, type SellerEndpointFacts } from "@/lib/sellers/board";
import { ATTRIBUTION_REVIEW_VALUE, buildSellerExportRows, SELLER_EXPORT_COLUMNS, SELLER_EXPORT_COLUMN_NOTES } from "@/lib/sellers/export";
import {
  cardLead,
  DISPUTE_NO_PURCHASE,
  FixFirstView,
  resultWordText,
  SellerDetailView,
  SellersIndexView,
  UNDER_RECHECK,
} from "@/components/site/sellers/SellersViews";

const NONCE = `0x${"ab".repeat(32)}`;
const TX = `0x${"cd".repeat(32)}`;
const FETCHED = "2026-10-20T13:00:00.000Z";

function row(p: Partial<SellerRowFacts>): SellerRowFacts {
  return {
    endpointId: "a",
    status: "settle_failed",
    httpStatusPaid: null,
    txHash: null,
    attemptedAt: "2026-10-20T12:02:08Z",
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

/** seller の側の候補の条件 (a)〜(e) を満たす行。 */
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
    authNonce: NONCE,
    ...p,
  });
}

function endpoint(id: string, lastAttemptAnyAt: string): SellerEndpointFacts {
  return {
    endpointId: id,
    resourceKey: `finance.example/${id}`,
    resourceUrl: `https://finance.example/${id}`,
    method: "GET",
    priceAmount: "10000",
    nextBuyFacts: { lastAttemptAnyAt, settledCount: 0, cooldown: false, latestL0Verdict: "pass", latestL0At: "2026-10-20T10:30:00Z" },
  };
}

function render(detail: ReturnType<typeof buildSellerDetail>): string {
  return renderToStaticMarkup(createElement(SellerDetailView, { detail, page: 1, now: Date.parse(detail.fetchedAt), revalidateSec: 300 }));
}

/** 公開の英文の決まり（we/our/us・セミコロン・ダッシュを使わない）。 */
function assertPlainEnglish(text: string, where: string) {
  assert.doesNotMatch(text, /\b(we|our|us)\b/i, `${where}: we/our/us`);
  assert.doesNotMatch(text, /;/, `${where}: semicolon`);
  assert.doesNotMatch(text, /—|–|--/, `${where}: dash`);
}

test("A-16: 署名から 90 分未満の 503（遅延回収の待ち）は Result に HTTP 503 を出し、「neither delivered nor failed」と言わない", () => {
  const r = proven({ httpStatusPaid: 503 });
  const d = buildSellerDetail("finance.example", [endpoint("a", r.attemptedAt)], [r], FETCHED);
  const l = d.listings[0];
  assert.equal(l.latest?.bucket, "pending", "数え方は保留のまま（遅延回収の待ち）");
  assert.equal(resultWordText(l.latest!), "HTTP 503 on the paid request, payment still being checked");
  const html = render(d);
  assert.doesNotMatch(html, /neither delivered nor failed/, "5xx の行を「失敗でも成功でもない」と読ませない");
  assert.match(html, /The paid request answered HTTP 503\. vet402 signed this payment less than 90 minutes/);
  const lead = cardLead(l)!;
  assert.equal(lead.length, 3);
  assert.equal(lead[0], "On 2026-10-20 12:02 UTC, vet402 signed a payment and the paid request answered HTTP 503.");
  assert.equal(lead[1], "vet402 is still looking for the transfer on-chain until 2026-10-20 13:32 UTC, so this row is not counted as delivered or failed yet.");
  assert.equal(
    lead[2],
    "If HTTP 503 is unexpected, check the route's logs, and the next purchase by vet402 is not before 2026-10-26 12:02 UTC, with no booked time. After that it depends on the daily budget and the order of demand.",
  );
  for (const s of lead) assertPlainEnglish(s, "lead");
  assert.ok(html.indexOf(lead[0]) < html.indexOf(">Result<"), "3 文はカードの先頭（Result より前）");
});

test("A-16: 1 回だけの 503 は「まだ売り手の側ではない」と理由を言い、直し方と次の購入の目安を続ける", () => {
  const r = proven({ httpStatusPaid: 503 });
  const d = buildSellerDetail("finance.example", [endpoint("a", r.attemptedAt)], [r], "2026-10-21T13:00:00.000Z");
  const lead = cardLead(d.listings[0])!;
  assert.equal(resultWordText(d.listings[0].latest!), "Server error on the paid request");
  assert.equal(
    lead[1],
    "This row is not on the seller's side yet, because that needs such a failure (a failure vet402 can show was not its own) at this listing on two different UTC days.",
  );
  assert.equal(
    lead[2],
    "If the failure is real, check the route's logs, and the next purchase by vet402 is not before 2026-10-26 12:02 UTC, with no booked time. After that it depends on the daily budget and the order of demand.",
  );
});

test("A-16: 別の日の 2 回で売り手の側になった行は、その日付と「attribution under review」を言う（帯の文は期限を作らない）", () => {
  const a = proven({ httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" });
  const b = proven({ httpStatusPaid: 503, attemptedAt: "2026-10-06T12:02:00Z" });
  const d = buildSellerDetail("finance.example", [endpoint("a", a.attemptedAt)], [a, b], "2026-10-21T13:00:00.000Z");
  assert.equal(d.hasConfirmedSeller, true);
  const lead = cardLead(d.listings[0])!;
  assert.equal(
    lead[1],
    "This row is on the seller's side (attribution under review), because such a failure (a failure vet402 can show was not its own) happened at this listing on two or more different UTC days, and the kind of failure on this row was seen on 2026-10-06 and 2026-10-12.",
  );
  // 再点検 中1: 窓が明けていても「いつでも買える」と書かない（予算と需要の順で決まる）。
  assert.equal(
    lead[2],
    "Check the route's logs, and the next purchase by vet402 is not before 2026-10-18 17:02 UTC, with no booked time. After that it depends on the daily budget and the order of demand.",
  );
  assert.doesNotMatch(lead.join(" "), /at any time|a failure like this/);
  const html = render(d);
  assert.equal((html.match(new RegExp(`>${UNDER_RECHECK}</span>`, "g")) ?? []).length, 2, "印は 2 行に");
  const page = readFileSync("src/app/sellers/[host]/page.tsx", "utf8");
  assert.doesNotMatch(page, /We are re-checking/, "帯に we を使わない・見直しに期限が無いと書く");
  assert.match(page, /the review has no set date/);
  assert.match(page, /A card with a computed time gives the earliest time\s+vet402 can buy that listing again/);
  // 再点検 r2 低: 期限の無い見直しで「移るかもしれない」と約束しない（どの形でも戻さない）。
  assert.doesNotMatch(page.replace(/\s+/g, " "), /may move|might move|could move|can move/i);
  assert.match(page, /If an attribution turns out wrong, the correction is published on/);
});

test("A-16: 支払う前の 503（not bought）も、HTTP の値と次の購入の目安を先頭で言う", () => {
  const r = row({ status: "no_402", network: null, unpaidStatus: 503, attemptedAt: "2026-10-20T15:32:14Z" });
  const d = buildSellerDetail("finance.example", [endpoint("a", r.attemptedAt)], [r], "2026-10-21T13:00:00.000Z");
  const lead = cardLead(d.listings[0])!;
  assert.equal(lead[0], "On 2026-10-20 15:32 UTC, the unpaid request answered HTTP 503 instead of a 402, so vet402 did not sign a payment.");
  assert.equal(lead[1], "This is not a purchase result, so it is not counted against the seller.");
  assert.match(lead[2], /^If HTTP 503 is unexpected, check the route's logs, and the next purchase by vet402 is not before 2026-10-26 15:32 UTC/);
});

test("A-16: delivered のカードには 3 文を出さない", () => {
  const r = proven({ status: "settled", httpStatusPaid: 200, txHash: `0x${"cd".repeat(32)}`, payloadNonEmpty: true, receiptPresent: true, receiptSuccess: true });
  const d = buildSellerDetail("finance.example", [endpoint("a", r.attemptedAt)], [r], "2026-10-21T13:00:00.000Z");
  assert.equal(d.listings[0].latest?.bucket, "delivered");
  assert.equal(cardLead(d.listings[0]), null);
});

test("A-16: 異議は購入を始めない（売り手頁の After a fix・記録頁の異議欄の直下・利用規約と同じ）", () => {
  assert.equal(DISPUTE_NO_PURCHASE, "A dispute does not start a purchase. The signed dispute route runs one fresh L0 check, an unpaid request.");
  assertPlainEnglish(DISPUTE_NO_PURCHASE, "DISPUTE_NO_PURCHASE");
  const r = proven({ httpStatusPaid: 503 });
  const html = render(buildSellerDetail("finance.example", [endpoint("a", r.attemptedAt)], [r], "2026-10-21T13:00:00.000Z"));
  assert.match(html, /A dispute does not start a purchase\./);
  const record = readFileSync("src/app/observatory/e/[id]/page.tsx", "utf8");
  const head = record.indexOf("<span>Dispute this record</span>");
  const said = record.indexOf("{DISPUTE_NO_PURCHASE}");
  assert.ok(head > 0 && said > head && said - head < 400, "異議欄の見出しの直下");
  assert.doesNotMatch(record, /re-measures through the normal publication gate/, "測り直しを買い直しと読ませる古い文");
  const terms = readFileSync("src/app/legal/terms/page.tsx", "utf8");
  assert.match(terms, /it does not trigger a new purchase/, "規約の文と食い違わない");
  assert.match(terms, /a dispute does not start a new purchase/);
  const lib = readFileSync("src/lib/observatory/disputes.ts", "utf8");
  assert.match(lib, /probeEndpoint\(/, "署名付きの異議は L0 を測るだけ");
  assert.doesNotMatch(lib, /runL1|payAndFetch|x402-payer/, "異議の経路は購入しない");
});

test("A-16: 頁の読み出しの時刻は、静かな時間の後の最初の表示が古くなりうると書く（freshness.ts と同じ）", () => {
  const r = proven({ httpStatusPaid: 503 });
  const html = render(buildSellerDetail("finance.example", [endpoint("a", r.attemptedAt)], [r], "2026-10-21T13:00:00.000Z"));
  assert.match(html, /The first view after a quiet period can show an older read\./);
  assert.match(readFileSync("src/lib/observatory/freshness.ts", "utf8"), /after a quiet spell one page view can be older than 5 minutes/);
});

test("A-16・A-17: 古い印の語（under re-check）と帯の文が公開面に戻らない", () => {
  for (const f of [
    "src/components/site/sellers/SellersViews.tsx",
    "src/app/sellers/[host]/page.tsx",
    "src/app/observatory/methodology/page.tsx",
    "src/app/observatory/e/[id]/page.tsx",
  ]) {
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /under re-check/, `${f}: under re-check`);
    assert.doesNotMatch(src.replace(/\s+/g, " "), /\b(some|rows?|failures?)\s+(may|might|could|can)\s+move\b/i, `${f}: 期限の無い「移るかもしれない」`);
  }
  assert.equal(UNDER_RECHECK, ATTRIBUTION_UNDER_REVIEW);
});

test("A-17: /sellers の表の上・カードと表の見出し・/sellers/fix-first に「attribution under review」と同じ注記", () => {
  assertPlainEnglish(ATTRIBUTION_REVIEW_NOTE, "ATTRIBUTION_REVIEW_NOTE");
  const a = proven({ endpointId: "a", httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" });
  const board = buildSellerBoard(
    [{ host: "finance.example", listings: 1 }],
    [{ ...a, host: "finance.example" }],
    "2026-10-21T13:00:00.000Z",
    null,
    new Map([["a", new Set(["2026-10-06"])]]),
  );
  assert.equal(board.totals.seller, 1);
  const index = renderToStaticMarkup(createElement(SellersIndexView, { board, page: 1, q: "", search: null, revalidateSec: 300 }));
  const note = ATTRIBUTION_REVIEW_NOTE.replace(/'/g, "&#x27;");
  assert.ok(index.includes(note), "一覧の表の上に注記");
  assert.ok(index.indexOf(note) < index.indexOf("<table"), "表より前");
  assert.match(index, /Seller&#x27;s side<span class="block text-xs font-normal">attribution under review<\/span><\/th>/);
  assert.match(index, /<dt[^>]*>Seller&#x27;s side \(attribution under review\)<\/dt>/);
  const fix = renderToStaticMarkup(createElement(FixFirstView, { board, revalidateSec: 300 }));
  assert.ok(fix.includes(note), "fix-first の売り手の側の節にも");
  assert.ok(fix.indexOf(note) > fix.indexOf("On the seller&#x27;s side</span>"));
});

test("A-17: sellers の CSV は column notes の先頭で同じ文を言い、seller の行に attribution_review=under_review。CC BY は変えない", () => {
  assert.ok(SELLER_EXPORT_COLUMN_NOTES.startsWith(`${ATTRIBUTION_REVIEW_NOTE} `));
  assert.match(SELLER_EXPORT_COLUMN_NOTES, /^[\x20-\x7e]+$/, "ヘッダは ASCII");
  assert.equal(SELLER_EXPORT_COLUMNS[SELLER_EXPORT_COLUMNS.length - 1], "attribution_review", "列は末尾に足すだけ");
  assert.equal(SELLER_EXPORT_COLUMNS[SELLER_EXPORT_COLUMNS.length - 2], "in_ledger_export", "既存の列の並びは変えない");
  const a = proven({ endpointId: "a", httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" });
  const b = proven({ endpointId: "b", httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" });
  const rows = buildSellerExportRows(
    [
      { endpointId: "a", resourceKey: "finance.example/a", host: "finance.example" },
      { endpointId: "b", resourceKey: "finance.example/b", host: "finance.example" },
      { endpointId: "c", resourceKey: "finance.example/c", host: "finance.example" },
    ],
    [{ ...a, host: "finance.example" }, { ...b, host: "finance.example" }],
    new Map([["a", new Set(["2026-10-06"])]]),
    Date.parse("2026-10-21T13:00:00Z"),
  );
  const by = new Map(rows.map((r) => [r.endpoint_id, r]));
  assert.equal(by.get("a")!.outcome, "seller");
  assert.equal(by.get("a")!.attribution_review, ATTRIBUTION_REVIEW_VALUE);
  assert.equal(by.get("b")!.outcome, "unsorted");
  assert.equal(by.get("b")!.attribution_review, "");
  assert.equal(by.get("c")!.attribution_review, "", "not_tried");
  const route = readFileSync("src/app/api/v1/sellers/export.csv/route.ts", "utf8");
  assert.match(route, /"x-vet402-license": "CC-BY-4.0"/, "ライセンスの変更はオーナーの判断（ここでは変えない）");
  assert.match(route, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(route, /"x-vet402-column-notes": SELLER_EXPORT_COLUMN_NOTES/);
});

test("再点検 高: 2 日の規則は種類を分けない。429 の日と 503 の日で確定した行は、503 の日だけを挙げる", () => {
  const latest = proven({ httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" });
  // 429 が seller の側の候補になるのは、tx があり着金を確かめた settle_failed（未決済の 4xx は refused_no_charge）。
  const older = proven({ httpStatusPaid: 429, attemptedAt: "2026-10-06T12:02:00Z", txHash: TX, settlementConfirmed: true });
  const d = buildSellerDetail("finance.example", [endpoint("a", latest.attemptedAt)], [latest, older], "2026-10-21T13:00:00.000Z");
  const l = d.listings[0];
  assert.equal(l.latest?.bucket, "seller", "種類の違う 2 日でも seller の側（fix-modes の規則）");
  assert.equal(l.earlier[0].mode?.key, "rate_limited");
  const lead = cardLead(l)!;
  assert.equal(
    lead[1],
    "This row is on the seller's side (attribution under review), because such a failure (a failure vet402 can show was not its own) happened at this listing on two or more different UTC days, and the kind of failure on this row was seen on 2026-10-12.",
  );
  assert.doesNotMatch(lead[1], /2026-10-06/, "429 の日を 503 と同じ種類として挙げない");
});

test("再点検 中2: 遅延回収の待ちの間、Last result about the seller と Whose side は HTTP の値を言う（awaiting on-chain は照合待ちだけ）", () => {
  const r = proven({ httpStatusPaid: 503 });
  const page = render(buildSellerDetail("finance.example", [endpoint("a", r.attemptedAt)], [r], FETCHED));
  const html = page.slice(page.indexOf('id="listing-a"'), page.indexOf("</li></ol>"));
  assert.match(html, /The latest purchase answered HTTP 503\. vet402 is still checking the chain\. There has been no attempt since\./);
  assert.match(html, /not sorted yet: HTTP 503, vet402 is still checking the chain/);
  assert.doesNotMatch(html, /awaiting on-chain verification/);
  assert.equal(sideFromWords("not sorted yet: HTTP 503, vet402 is still checking the chain"), "pending", "surface canary は CSV の pending と突き合わせる");
  const claimed = proven({ status: "settle_claimed", httpStatusPaid: 200, txHash: `0x${"cd".repeat(32)}` });
  const html2 = render(buildSellerDetail("finance.example", [endpoint("a", claimed.attemptedAt)], [claimed], FETCHED));
  assert.match(html2, /The latest purchase is awaiting on-chain verification/, "照合待ちは従来の語のまま");
});

/** 描画した HTML の表示文（タグを外し、実体を戻す）。 */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

test("再点検 中3: 描画した売り手のカード（503 の待ち・1 回・確定・429 と 503）に we/our/us・セミコロン・ダッシュが無い", () => {
  const cases = [
    [proven({ httpStatusPaid: 503 })],
    [proven({ httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" })],
    [proven({ httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" }), proven({ httpStatusPaid: 503, attemptedAt: "2026-10-06T12:02:00Z" })],
    [
      proven({ httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" }),
      proven({ httpStatusPaid: 429, attemptedAt: "2026-10-06T12:02:00Z", txHash: TX, settlementConfirmed: true }),
    ],
  ];
  for (const [i, rows] of cases.entries()) {
    const d = buildSellerDetail("finance.example", [endpoint("a", rows[0].attemptedAt)], rows, i === 0 ? FETCHED : "2026-10-21T13:00:00.000Z");
    const html = render(d);
    const start = html.indexOf('id="listing-a"');
    assert.ok(start > 0);
    const end = html.indexOf("</li></ol>", start);
    assert.ok(end > start);
    const card = visibleText(html.slice(html.lastIndexOf("<li", start), end));
    assert.match(card, /What vet402 saw:/);
    assertPlainEnglish(card, `card ${i}`);
  }
});

test("再点検 r2 中: 429 の日と 503 の日で outcome=seller。CSV の列注記と規則の文は「same kind of failure」と言わない", () => {
  const latest = proven({ endpointId: "a", httpStatusPaid: 503, attemptedAt: "2026-10-12T17:02:17Z" });
  const older = proven({ endpointId: "a", httpStatusPaid: 429, attemptedAt: "2026-10-06T12:02:00Z", txHash: TX, settlementConfirmed: true });
  const rows = buildSellerExportRows(
    [{ endpointId: "a", resourceKey: "finance.example/a", host: "finance.example" }],
    [{ ...latest, host: "finance.example" }],
    // reader の readSellerFailureDays と同じ材料: seller の側の候補になった行の UTC の日付。
    new Map([["a", new Set([sellerCandidateDay(older) ?? ""])]]),
    Date.parse("2026-10-21T13:00:00Z"),
  );
  assert.equal(sellerCandidateDay(older), "2026-10-06", "429 の日も seller の側の候補");
  assert.equal(rows[0].outcome, "seller");
  assert.equal(rows[0].fix_mode, "server_error_paid");
  assert.doesNotMatch(SELLER_EXPORT_COLUMN_NOTES, /same kind of failure/);
  assert.match(SELLER_EXPORT_COLUMN_NOTES, /such a failure, of any kind, was seen at the listing on 2 or more different UTC days/);
  for (const f of ["public/llms.txt", "docs/openapi.yaml", "packages/mcp-server/src/rules-text.generated.ts", "packages/mcp-server/dist/rules-text.generated.js"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /same kind of failure/, `${f}: 生成物を gen-rules-text で揃える`);
  }
});
