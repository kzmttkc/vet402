// /docs/api の本体はサーバーの HTML にも出す（2026-11-23）。
// 2026-11-21 の速度の直し（0a6fc635）で ApiDocsRest と ApiEndpointsSection を next/dynamic の ssr:false にした結果、
// 本番の HTML には Quickstart しか残らず、理由コードの表もエンドポイント一覧も検索・エージェント・surface-canary から
// 見えなくなった（issue #107 が 11/21〜23 赤のまま）。文書の突合の試験はソースの文字を読むので気づけなかった。
// ここでは /docs/api に繋がる遅延読み込みの部品が ssr:false を持たないことを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const LAZY = ["src/components/docs/ApiDocsRestLazy.tsx", "src/components/docs/ApiEndpointsSectionLazy.tsx"];

for (const rel of LAZY) {
  test(`${rel} は server render を外さない（ssr:false を持たない）`, () => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /ssr\s*:\s*false/, `${rel} に ssr:false がある。/docs/api の本体が HTML から消える`);
  });
}

test("/docs/api の page は遅延読み込みの部品を通して本体を描く（経路が変わったらこの試験も直す）", () => {
  const page = readFileSync(join(ROOT, "src/app/docs/api/page.tsx"), "utf8");
  assert.match(page, /ApiDocsRestLazy/);
  const rest = readFileSync(join(ROOT, "src/components/docs/ApiDocsRest.tsx"), "utf8");
  assert.match(rest, /ApiEndpointsSectionLazy/);
  assert.match(rest, /id=\{`reason-/);
});
