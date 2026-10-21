// ============================================================
// /sellers/[host] の 2 つの足し分（2026-09-29 監査 第2巡）:
//   1. 各出品の行に「Email me when this result changes」→ 記録頁の通知登録欄（#notify）
//   2. Base の出品が無いが購入行のある host は 404 にせず、記録頁への簡易頁（noindex は頁の metadata）
// 頁の判定（resolveSellerPage）は DB を外して 3 通りを固定する。読み取りそのものは
// tests/sellers-other-chains.pg.test.ts が本物の Postgres で見る。
// ============================================================
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RECORD_NOTIFY_ANCHOR,
  SellerDetailView,
  SellerOtherChainsView,
} from "@/components/site/sellers/SellersViews";
import {
  buildSellerBoard,
  buildSellerDetail,
  buildSellerOtherChains,
  resolveSellerPage,
  sellerExactRedirectHost,
  sellerSearchRedirect,
  type SellerOtherChains,
} from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const FETCHED = "2026-09-29T01:00:00.000Z";
const ARC = "eip155:5042";

function r(p: Partial<SellerRowFacts>): SellerRowFacts {
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

const baseEps = [
  { endpointId: "b1", resourceKey: "shop.example/a", resourceUrl: "https://shop.example/a", method: "GET", priceAmount: "1000" },
  { endpointId: "b2", resourceKey: "shop.example/b", resourceUrl: "https://shop.example/b", method: "GET", priceAmount: "1000" },
];
const baseRows = [r({ endpointId: "b1", status: "settled", httpStatusPaid: 200, txHash: `0x${"ab".repeat(32)}` })];

const other: SellerOtherChains = buildSellerOtherChains(
  "edge.goldsky.example",
  [
    {
      resourceKey: "edge.goldsky.example/old",
      catalogNetwork: ARC,
      facts: r({ endpointId: "g1", network: ARC, status: "settle_failed", httpStatusPaid: 500, attemptedAt: "2026-09-18T00:00:00Z" }),
    },
    {
      resourceKey: "edge.goldsky.example/new",
      catalogNetwork: ARC,
      facts: r({ endpointId: "g2", network: ARC, status: "settled", httpStatusPaid: 200, attemptedAt: "2026-09-25T09:30:00Z" }),
    },
    {
      // 支払い前に止まった行は network が無い → カタログの代表 network で名前を出す
      resourceKey: "edge.goldsky.example/unpaid",
      catalogNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      facts: r({ endpointId: "g3", network: null, status: "no_402", unpaidStatus: 404, attemptedAt: "2026-09-20T00:00:00Z" }),
    },
  ],
  FETCHED,
)!;

test("Base の頁: 出品ごとに記録頁の通知登録欄へのリンク（買っていない出品にも）", () => {
  const d = buildSellerDetail("shop.example", baseEps, baseRows, FETCHED);
  const html = renderToStaticMarkup(createElement(SellerDetailView, { detail: d, page: 1, now: Date.parse(FETCHED), revalidateSec: 300 }));
  for (const id of ["b1", "b2"]) {
    assert.match(html, new RegExp(`<a [^>]*href="/observatory/e/${id}#${RECORD_NOTIFY_ANCHOR}"[^>]*>Email me when this result changes</a>`));
  }
});

test("記録頁の通知登録欄にアンカーがある（リンク先で登録欄に着く）", () => {
  const src = readFileSync("src/app/observatory/e/[id]/page.tsx", "utf8");
  assert.match(
    src,
    new RegExp(`<div id="${RECORD_NOTIFY_ANCHOR}"[^>]*>\\s*<RecordSubscribe endpointId=\\{id\\} kind="notify" />\\s*</div>`),
    "id の付いた要素の直下が通知の RecordSubscribe",
  );
});

test("resolveSellerPage: Base あり／Base 無し・購入あり／どちらも無し の 3 通り", async () => {
  const board = buildSellerBoard([{ host: "shop.example", listings: 2 }], baseRows.map((x) => ({ ...x, host: "shop.example" })), FETCHED);
  const calls: string[] = [];
  const load = {
    board: async () => board,
    detail: async (h: string) => (calls.push(`detail:${h}`), h === "shop.example" ? buildSellerDetail(h, baseEps, baseRows, FETCHED) : null),
    purchasedHosts: async () => (calls.push("purchasedHosts"), ["edge.goldsky.example", "shop.example"]),
    otherChains: async (h: string) => (calls.push(`other:${h}`), h === "edge.goldsky.example" ? other : null),
  };

  const a = await resolveSellerPage("shop.example", load);
  assert.equal(a.kind, "base");
  assert.deepEqual(calls.splice(0), ["detail:shop.example"], "Base の頁は他チェーンの読み取りをしない");

  const b = await resolveSellerPage("edge.goldsky.example", load);
  assert.equal(b.kind, "other_chains");
  assert.equal(b.kind === "other_chains" && b.other.host, "edge.goldsky.example");
  assert.deepEqual(calls.splice(0), ["purchasedHosts", "other:edge.goldsky.example"]);

  const c = await resolveSellerPage("nobody.example", load);
  assert.equal(c.kind, "none");
  assert.deepEqual(calls.splice(0), ["purchasedHosts"], "購入行も無い host は host ごとの読み取りを走らせない（従来どおり 404）");
});

test("SellerOtherChainsView: 記録頁へのリンク・チェーン名・最新の日時・平易な結果・通知リンク", () => {
  const html = renderToStaticMarkup(createElement(SellerOtherChainsView, { other, revalidateSec: 300 }));
  assert.match(html, /Read from the database 2026-09-29 01:00 UTC/);
  assert.match(html, /<h1[^>]*>Purchase records for <span[^>]*>edge\.goldsky\.example<\/span><\/h1>/);
  assert.match(html, /no active Base listing/);
  assert.match(html, /Purchase records on Arc and Solana are on this page/);
  assert.match(html, /href="\/sellers"/);
  for (const id of ["g1", "g2", "g3"]) {
    assert.match(html, new RegExp(`href="/observatory/e/${id}"`));
    assert.match(html, new RegExp(`href="/observatory/e/${id}#${RECORD_NOTIFY_ANCHOR}"`));
  }
  assert.match(html, /<td[^>]*>\s*Arc\s*<code>eip155:5042<\/code>\s*<\/td>/);
  assert.match(html, /<td[^>]*>\s*Solana\s*<\/td>/, "network の無い行はカタログの代表 network。台帳 id は無い");
  assert.match(html, /2026-09-25 09:30 UTC/);
  assert.match(html, />delivered</);
  assert.match(html, /<code>settle_failed<\/code> · HTTP 500/);
  // 最新の購入が新しい順
  assert.ok(html.indexOf("/observatory/e/g2\"") < html.indexOf("/observatory/e/g3\""));
  assert.ok(html.indexOf("/observatory/e/g3\"") < html.indexOf("/observatory/e/g1\""));
});

test("sellerExactRedirectHost: Base の完全一致、購入ホスト、部分一致", () => {
  const board = [{ host: "shop.example" }, { host: "shop.example.com" }];
  assert.equal(sellerExactRedirectHost(board, "shop.example", []), null, "部分一致がある完全一致は一覧に残す");
  assert.equal(sellerExactRedirectHost([{ host: "shop.example" }], "https://shop.example/a", []), "shop.example");
  assert.equal(
    sellerExactRedirectHost([{ host: "shop.example" }], "https://api.solenrich.com/path", ["api.solenrich.com"]),
    "api.solenrich.com",
  );
  assert.equal(sellerExactRedirectHost([{ host: "shop.example" }], "nobody.example", ["api.solenrich.com"]), null);
  assert.equal(sellerExactRedirectHost(board, "shop.example", ["shop.example"]), null);
});

test("sellerSearchRedirect: 読み取り失敗は空の購入ホストと分ける", () => {
  const sellers = [{ host: "shop.example" }];
  assert.deepEqual(sellerSearchRedirect(sellers, "api.solenrich.com", { ok: false }), { host: null, failed: true });
  assert.deepEqual(sellerSearchRedirect(sellers, "api.solenrich.com", { ok: true, hosts: [] }), { host: null, failed: false });
  assert.deepEqual(
    sellerSearchRedirect(sellers, "https://api.solenrich.com/path?x=1", { ok: true, hosts: ["api.solenrich.com"] }),
    { host: "api.solenrich.com", failed: false },
  );
});

test("検索頁は購入ホストの読み取り失敗を空の一致と分ける", () => {
  const src = readFileSync("src/app/sellers/page.tsx", "utf8");
  assert.match(src, /sellerSearchRedirect/);
  assert.match(src, /if \(gate\.host\) redirect\(sellerPath\(gate\.host\)\)/);
  assert.match(src, /getPurchasedHostsCached/);
  assert.match(src, /purchasedLookupFailed/);
  assert.doesNotMatch(src, /getPurchasedHostsCached\(\)\s*\.catch\(\(\) => \[\]/);
});

test("readSellerDetail の他チェーンは署名済み status を settle_failed 込みで読む", () => {
  const src = readFileSync("src/lib/sellers/reader.ts", "utf8");
  const start = src.indexOf("const otherRaw");
  const end = src.indexOf("return buildSellerDetail", start);
  assert.ok(start >= 0 && end > start);
  const slice = src.slice(start, end);
  assert.match(slice, /\[\.\.\.SIGNED_ROW_STATUSES\]/);
  assert.doesNotMatch(slice, /sql`settled`/);
});

test("売り手頁の題と dateModified は sellerHeadline の時刻", () => {
  const src = readFileSync("src/app/sellers/[host]/page.tsx", "utf8");
  assert.match(src, /sellerHeadline\(detailForTitle\)/);
  assert.match(src, /sellerHeadline\(detail\)/);
  assert.match(src, /dateModified: head\.at/);
  assert.doesNotMatch(src, /dateModified: detail\.summary\.lastAttemptAt/);
});

test("buildSellerOtherChains: stellar:pubnet は公開名 Stellar。台帳 id は列に残す", () => {
  const built = buildSellerOtherChains(
    "star.example",
    [{
      resourceKey: "star.example/a",
      catalogNetwork: "stellar:pubnet",
      facts: r({ endpointId: "s1", network: "stellar:pubnet", status: "settle_failed", httpStatusPaid: 402, attemptedAt: "2026-10-18T21:30:42Z" }),
    }],
    FETCHED,
  );
  assert.equal(built?.listings[0]?.chain, "Stellar");
  const html = renderToStaticMarkup(createElement(SellerOtherChainsView, { other: built!, revalidateSec: 300 }));
  assert.match(html, /Purchase records on Stellar are on this page/);
  assert.doesNotMatch(html, /Purchase records on stellar:pubnet/);
  assert.match(html, /<code>stellar:pubnet<\/code>/);
});

test("buildSellerOtherChains: 購入行が無ければ null（頁は 404）", () => {
  assert.equal(buildSellerOtherChains("x.example", [], FETCHED), null);
});

test("頁: Base の一覧に居ない host の metadata は noindex", () => {
  const src = readFileSync("src/app/sellers/[host]/page.tsx", "utf8");
  assert.match(src, /if \(!onBoard\) \{[\s\S]*?noindex: true[\s\S]*?\}\);/);
});
