// ============================================================
// L1 の支払い付き要求のクエリ（2026-09-20）。
//
// 無払いの 402 応答（PAYMENT-REQUIRED ヘッダの base64 JSON、または本文の JSON）に
// extensions.bazaar.info.input.queryParams があり、それが「名前 → スカラー値」の object なら、
// 支払い付き要求の URL にその名前と値をそのまま足す。値は宣言の中に実在するものだけ
// （スキーマの description の "e.g." を読まない・enum の先頭を選ばない・既定値を作らない）。
// それ以外（宣言なし・空・スカラーでない値・上限超）は従来どおりカタログの URL のまま。
//
// 実測（2026-09-20・本番）: macropulse.theaslangroupllc.com/api/market/is-open の 402 は
// queryParams: { exchange: "NYSE", at: "2026-12-25T14:30:00Z" } を宣言していたが、L1 は
// 付けずに払い、400 missing_parameter を受けていた（XRPL レーンの直近 6 件中 4 件）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECLARED_QUERY_MAX_BYTES,
  DECLARED_QUERY_MAX_PARAMS,
  DECLARED_URL_MAX_BYTES,
  declaredRequestUrl,
} from "@/lib/observatory/declared-input";
import { BASE_USDC } from "@/lib/observatory/x402-payer";

const accepts = [
  { scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: `0x${"1".repeat(40)}`, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
];
const URL_PLAIN = "https://macropulse.example/api/market/is-open";
const doc = (queryParams: unknown) => ({
  x402Version: 2,
  accepts,
  extensions: { bazaar: { info: { input: { type: "http", method: "GET", queryParams } } } },
});
const header = (v: unknown) => new Headers({ "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(v)).toString("base64") });
const run = (queryParams: unknown, resourceUrl = URL_PLAIN) =>
  declaredRequestUrl({ resourceUrl, bodyText: "", headers: header(doc(queryParams)) });

test("ヘッダの宣言（名前 → 文字列）は URL のクエリになる。値は宣言のまま", () => {
  const r = run({ exchange: "NYSE", at: "2026-12-25T14:30:00Z" });
  assert.equal(r.source, "declared");
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, URL_PLAIN);
  assert.deepEqual([...u.searchParams.entries()], [["exchange", "NYSE"], ["at", "2026-12-25T14:30:00Z"]]);
});

test("本文の宣言も読む（ヘッダに accepts が無いとき）。数値と真偽値は文字列にして送る", () => {
  const r = declaredRequestUrl({ resourceUrl: URL_PLAIN, bodyText: JSON.stringify(doc({ limit: 8, open: true, q: "stable coin&x=1" })), headers: new Headers() });
  assert.equal(r.source, "declared");
  assert.deepEqual([...new URL(r.url).searchParams.entries()], [["limit", "8"], ["open", "true"], ["q", "stable coin&x=1"]]);
});

test("宣言が無い・空・object でないなら URL は 1 文字も変わらない", () => {
  for (const bad of [undefined, null, {}, [], ["exchange"], "exchange=NYSE", 1, true]) {
    assert.deepEqual(run(bad), { url: URL_PLAIN, source: "empty" }, JSON.stringify(bad));
  }
  assert.deepEqual(
    declaredRequestUrl({ resourceUrl: URL_PLAIN, bodyText: "not json", headers: new Headers({ "PAYMENT-REQUIRED": "%%%" }) }),
    { url: URL_PLAIN, source: "empty" },
  );
});

test("スカラーでない値・空の名前が 1 つでもあれば宣言ごと使わない（一部だけ送らない）", () => {
  for (const bad of [
    { exchange: "NYSE", at: null },
    { exchange: ["NYSE", "LSE"] },
    { exchange: { code: "NYSE" } },
    { exchange: Number.NaN },
    { "": "NYSE" },
  ]) {
    assert.deepEqual(run(bad), { url: URL_PLAIN, source: "empty" }, JSON.stringify(bad));
  }
});

test("値を作らない: スキーマの required・enum・default・description は読まない", () => {
  const d = {
    x402Version: 2,
    accepts,
    extensions: {
      bazaar: {
        info: { input: { type: "http", method: "GET" } },
        schema: {
          properties: {
            input: {
              properties: {
                queryParams: {
                  required: ["exchange"],
                  properties: { exchange: { type: "string", enum: ["NYSE"], default: "NYSE", description: "e.g. NYSE" } },
                },
              },
            },
          },
        },
      },
    },
  };
  assert.deepEqual(declaredRequestUrl({ resourceUrl: URL_PLAIN, bodyText: "", headers: header(d) }), { url: URL_PLAIN, source: "empty" });
});

test("カタログの URL に既にある名前は上書きしない。既存のクエリは 1 文字も書き換えない", () => {
  const listed = "https://macropulse.example/api/market/is-open?exchange=LSE&note=a%20b";
  const r = run({ exchange: "NYSE", at: "now" }, listed);
  assert.equal(r.source, "declared");
  assert.equal(r.url, `${listed}&at=now`);
  // 足す名前が残らなければ URL はそのまま。
  assert.deepEqual(run({ exchange: "NYSE" }, listed), { url: listed, source: "empty" });
});

test("フラグメントは送らない部分なので、クエリはその手前に入る", () => {
  const r = run({ exchange: "NYSE" }, `${URL_PLAIN}#top`);
  assert.equal(r.url, `${URL_PLAIN}?exchange=NYSE`);
});

test("ホストと経路は変わらない（値に URL の区切り文字があっても）", () => {
  const r = run({ next: "https://evil.example/?a=1#x", "a/b?c#d": "@evil.example" });
  assert.equal(r.source, "declared");
  const u = new URL(r.url);
  assert.equal(u.origin, "https://macropulse.example");
  assert.equal(u.pathname, "/api/market/is-open");
  assert.equal(u.hash, "");
  assert.deepEqual([...u.searchParams.entries()], [["next", "https://evil.example/?a=1#x"], ["a/b?c#d", "@evil.example"]]);
});

test("上限: 名前の数・クエリのバイト数・URL 全体のバイト数。超えたら宣言ごと使わない", () => {
  const many = Object.fromEntries(Array.from({ length: DECLARED_QUERY_MAX_PARAMS + 1 }, (_, i) => [`k${i}`, "v"]));
  assert.equal(run(many).source, "empty");
  const atLimit = Object.fromEntries(Array.from({ length: DECLARED_QUERY_MAX_PARAMS }, (_, i) => [`k${i}`, "v"]));
  assert.equal(run(atLimit).source, "declared");

  // "q=" + n 文字でちょうど上限。
  const exact = "a".repeat(DECLARED_QUERY_MAX_BYTES - 2);
  assert.equal(run({ q: exact }).source, "declared");
  assert.deepEqual(run({ q: `${exact}a` }), { url: URL_PLAIN, source: "empty" });
  // 上限は符号化した後のバイト数で測る（「あ」は %E3%81%82 で 9 バイト）。
  assert.equal(run({ q: "あ".repeat(Math.ceil(DECLARED_QUERY_MAX_BYTES / 9)) }).source, "empty");

  const longListed = `https://macropulse.example/${"p".repeat(DECLARED_URL_MAX_BYTES - 40)}`;
  assert.deepEqual(run({ exchange: "NYSE" }, longListed), { url: longListed, source: "empty" });
});

test("読むのは支払い条件を取ったのと同じ文書だけ。読めない URL は触らない", () => {
  const noAccepts = { x402Version: 2, extensions: doc({ exchange: "NYSE" }).extensions };
  assert.deepEqual(declaredRequestUrl({ resourceUrl: URL_PLAIN, bodyText: "", headers: header(noAccepts) }), { url: URL_PLAIN, source: "empty" });
  const r = declaredRequestUrl({ resourceUrl: URL_PLAIN, bodyText: JSON.stringify(doc({ exchange: "LSE" })), headers: header(doc({ exchange: "NYSE" })) });
  assert.equal(new URL(r.url).searchParams.get("exchange"), "NYSE", "ヘッダが accepts を持てばヘッダ");
  assert.deepEqual(declaredRequestUrl({ resourceUrl: "not a url", bodyText: "", headers: header(doc({ exchange: "NYSE" })) }), { url: "not a url", source: "empty" });
});
