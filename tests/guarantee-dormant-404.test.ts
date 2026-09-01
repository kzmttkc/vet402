// ============================================================
// 2026-09-01 監査: 休眠中の金融商品（保証の見積もり）が、フラグ OFF でも
// **実在を漏らしていた**。
//
// 実測（本番・2026-09-01）:
//   GET  /api/v1/guarantee/quote → 404
//   POST /api/v1/guarantee/quote → 405  ← 405 は「ルートは在るがメソッド不可」
//   実在しないパス              → 全メソッド 404（/api/[...unmatched]）
//
// ルートが GET しか輸出していなかったため、他メソッドは Next.js の既定 405 に
// 落ちていた。route.ts 自身が「存在しないかのように 404 を返す」「休眠中の
// 金融商品は discoverable であってはならない」と宣言していたのに、その宣言が
// GET でしか成立していなかった——主張と実装のずれ。
//
// ここで固定するのは「OFF ならどのメソッドでも実在しないパスと区別がつかない」。
// ON のときは GET が通り、他は 405（公開後にメソッド違いを隠す理由はない）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src", "app", "api", "v1", "guarantee", "quote", "route.ts"),
  "utf8",
);

test("GET 以外のメソッドも輸出されている（既定405に落とさない）", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    assert.match(
      src,
      new RegExp(`export const ${m}\\b`),
      `${m} が未輸出——Next の既定 405 が返り、フラグ OFF でも実在が漏れる`,
    );
  }
});

test("OFF のときは 404 を返す分岐がある", () => {
  assert.match(src, /isGuaranteeUnderwritingEnabled\(\)/, "フラグ判定が消えている");
  assert.match(src, /status: 404/, "404 を返す経路が無い");
});

test("メソッド共通ハンドラが OFF を先に見る（405 を先に返さない）", () => {
  const fn = src.match(/function methodNotAllowedOrHidden\(\)[\s\S]{0,300}?\n}/);
  assert.ok(fn, "共通ハンドラが見つからない");
  const body = fn![0];
  const offAt = body.indexOf("isGuaranteeUnderwritingEnabled");
  const at405 = body.indexOf("405");
  assert.ok(offAt >= 0 && at405 >= 0, "分岐が揃っていない");
  assert.ok(offAt < at405, "405 をフラグ判定より先に返している——OFF でも実在が漏れる");
});

test("公開仕様が「discoverable でない」と過剰主張していない", () => {
  // openapi.yaml 自身がパスとフラグ名を公開しているので、
  // 「discoverable であってはならない」は内部矛盾。守るべきは quotable でないこと。
  const spec = readFileSync(join(process.cwd(), "docs", "openapi.yaml"), "utf8");
  const start = spec.indexOf("/api/v1/guarantee/quote — gated");
  assert.ok(start >= 0, "仕様の該当ブロックが見つからない");
  const end = spec.indexOf("turns it on.", start);
  assert.ok(end > start, "該当ブロックの終端が見つからない");
  const block = [spec.slice(start, end + 12)];
  assert.doesNotMatch(
    block![0],
    /must not be discoverable/,
    "パスを自ら公開しているファイルで『discoverable であってはならない』と書いている（内部矛盾）",
  );
  assert.match(block![0], /QUOTABLE|quotable/, "守るべき性質（quotable でない）が書かれていない");
});
