// ============================================================
// §7.3 逆引き: ドメイン → endpoint の LIKE パターン。
//
// 2026-09-02 敵対的監査: lookup.ts の `LIKE ${"%." + host + "/%"}` は host 内の
// `_` をエスケープしていなかった。`a_b.example` は `a` + 任意 1 文字 + `b.example`
// に一致し、`axb.example` の店が `a_b.example` の逆引きに混ざる。
// /observatory の検索（reader.searchLikePattern）と同じ規則を共通化する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeLike } from "@/lib/util/like";
import { domainLikePatterns } from "@/lib/resolve/lookup";
import { searchLikePattern } from "@/lib/observatory/reader";

test("escapeLike は % _ \\ をバックスラッシュでエスケープする", () => {
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a\\b"), "a\\\\b");
  assert.equal(escapeLike("plain.example"), "plain.example");
});

test("domainLikePatterns は host の _ をリテラルにし、サブドメインとパスの 3 形を返す", () => {
  assert.deepEqual(domainLikePatterns("a_b.example"), ["a\\_b.example/%", "%.a\\_b.example/%", "%.a\\_b.example"]);
});

test("domainLikePatterns は大文字を小文字に揃える（resource_key は小文字）", () => {
  assert.deepEqual(domainLikePatterns("API.Example"), ["api.example/%", "%.api.example/%", "%.api.example"]);
});

test("reader.searchLikePattern と同じエスケープ規則である", () => {
  assert.equal(searchLikePattern("a_b%c\\d"), `%${escapeLike("a_b%c\\d")}%`);
});
