// ============================================================
// パステンプレート URL の検出（2026-09-02 監査 A1・オーナー決定）。
//
// `/v1/entreprise/:siren` のような未置換のパスパラメータを持つ URL は、
// 我々にはパラメータの実値が分からないので**正しいリクエストを作れない**。
// 叩けば 400/404 が返り、それは売り手の不履行ではなく我々の都合。
// L0 は外向き要求を出さずに unverified(path_template)、L1 は候補から外す。
//
// 境界: `:` を含む正当なセグメント（`/api/v1:beta`）、ポート番号、
// クエリ文字列の中の値は**テンプレートではない**。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { PATH_TEMPLATE_PG_REGEX, isPathTemplate, pathTemplateReason } from "@/lib/observatory/path-template";

test("Express 風 `:name` セグメントはテンプレート", () => {
  assert.equal(isPathTemplate("https://ph.example/v1/entreprise/:siren"), true);
  assert.equal(isPathTemplate("https://x.example/users/:user_id/posts"), true);
  assert.equal(isPathTemplate("https://x.example/:id"), true);
});

test("`{name}` `<name>` `[name]` `*` のセグメントはテンプレート", () => {
  assert.equal(isPathTemplate("https://x.example/items/{itemId}"), true);
  assert.equal(isPathTemplate("https://x.example/items/<id>"), true);
  assert.equal(isPathTemplate("https://x.example/items/[slug]"), true);
  assert.equal(isPathTemplate("https://x.example/files/*"), true);
  assert.equal(isPathTemplate("https://x.example/files/*/download"), true);
});

test("URL エンコードされた `%7Bname%7D` もテンプレート", () => {
  assert.equal(isPathTemplate("https://x.example/items/%7BitemId%7D"), true);
  assert.equal(isPathTemplate("https://x.example/items/%7bitemId%7d"), true);
});

test("セグメントの途中に `:` があるだけならテンプレートではない", () => {
  assert.equal(isPathTemplate("https://x.example/api/v1:beta"), false);
  assert.equal(isPathTemplate("https://x.example/projects/a:b/run"), false);
});

test("ポート番号・スキームの `:` はテンプレートではない", () => {
  assert.equal(isPathTemplate("https://host:8443/api"), false);
  assert.equal(isPathTemplate("http://host:8080/"), false);
  assert.equal(isPathTemplate("https://host:8443/v1/entreprise/:siren"), true);
});

test("クエリ文字列の値は対象外", () => {
  assert.equal(isPathTemplate("https://x.example/search?q=:term"), false);
  assert.equal(isPathTemplate("https://x.example/search?tpl={x}&b=[y]"), false);
  assert.equal(isPathTemplate("https://x.example/a/:id?q=1"), true);
});

test("通常の URL はテンプレートではない", () => {
  assert.equal(isPathTemplate("https://x.example/api"), false);
  assert.equal(isPathTemplate("https://x.example/"), false);
  assert.equal(isPathTemplate("https://x.example"), false);
  assert.equal(isPathTemplate("https://x.example/v1/quote/ETH-USD"), false);
});

test("パースできない文字列は false（別の理由で落ちる。ここで嘘を言わない）", () => {
  assert.equal(isPathTemplate("not a url"), false);
  assert.equal(isPathTemplate(""), false);
});

test("pathTemplateReason は理由語彙そのもの", () => {
  assert.equal(pathTemplateReason("https://x.example/:id"), "path_template");
  assert.equal(pathTemplateReason("https://x.example/id"), null);
});

// ---- SQL 側の同じ判定（L1 候補選定・coverage 階層の WHERE 句） -------------

test("Postgres 用の正規表現は isPathTemplate と同じ判定を返す（二重防御の整合）", () => {
  const corpus: [string, boolean][] = [
    ["https://ph.example/v1/entreprise/:siren", true],
    ["https://x.example/users/:user_id/posts", true],
    ["https://x.example/:id", true],
    ["https://x.example/items/{itemId}", true],
    ["https://x.example/items/%7BitemId%7D", true],
    ["https://x.example/items/<id>", true],
    ["https://x.example/items/[slug]", true],
    ["https://x.example/files/*", true],
    ["https://x.example/files/*/download", true],
    ["https://x.example/api/v1:beta", false],
    ["https://x.example/projects/a:b/run", false],
    ["https://host:8443/api", false],
    ["http://host:8080/", false],
    ["https://host:8443/v1/entreprise/:siren", true],
    ["https://x.example/search?q=:term", false],
    ["https://x.example/search?tpl={x}&b=[y]", false],
    ["https://x.example/a/:id?q=1", true],
    ["https://x.example/api", false],
    ["https://x.example/", false],
    ["https://x.example/v1/quote/ETH-USD", false],
  ];
  const pg = new RegExp(PATH_TEMPLATE_PG_REGEX, "i");
  for (const [url, expected] of corpus) {
    assert.equal(isPathTemplate(url), expected, `isPathTemplate(${url})`);
    // SQL 側は split_part(resource_url, '?', 1) !~* PATTERN
    assert.equal(pg.test(url.split("?")[0]), expected, `pg regex(${url})`);
  }
});
