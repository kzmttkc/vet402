// ============================================================
// 2026-08-26 C1リハーサル: apiUrl に origin だけ渡す（/api/v1 欠落）と
// 本番が HTML ページを 200 で返す。以前の SDK は json 化失敗を握りつぶし、
// 2xx なら {} を成功として返していた——全フィールド undefined の
// PayeeScoreResult が SpendGuard へ渡り、Date.parse(undefined)=NaN で
// fail-closed の payee_score_stale になり、統合者が黙って壊れた。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVouchClient, VouchApiError } from "../dist/index.js";

const htmlFetch = async () =>
  new Response("<!DOCTYPE html><html><body>Not our API</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

test("2xx でも本文が JSON でなければ握りつぶさず throw する", async () => {
  const c = createVouchClient({ apiKey: "k", fetch: htmlFetch });
  await assert.rejects(
    () => c.getPayeeScore("0x36038e1d712c5e39f35952164ec58ec2b96caee7"),
    (e) => {
      assert.ok(e instanceof VouchApiError, "VouchApiError であること");
      assert.equal(e.code, "vouch_non_json_response");
      return true;
    },
    "HTML 200 を空の成功として返している——統合者が undefined フィールドで黙って壊れる",
  );
});

test("正しい JSON はこれまで通り読める（回帰防止）", async () => {
  const okFetch = async () =>
    new Response(
      JSON.stringify({
        payee: "0x36038e1d712c5e39f35952164ec58ec2b96caee7",
        score: 69,
        recommendation: "WARN",
        dataDepth: "thin",
        degraded: false,
        signalsUnavailable: [],
        signals: {},
        scoredAt: new Date().toISOString(),
        cacheExpiresAt: new Date(Date.now() + 300000).toISOString(),
        disclaimer: "x",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const c = createVouchClient({ apiKey: "k", fetch: okFetch });
  const s = await c.getPayeeScore("0x36038e1d712c5e39f35952164ec58ec2b96caee7");
  assert.equal(s.recommendation, "WARN");
  assert.equal(s.score, 69);
});

test("非2xxのエラーは従来どおりコードを保つ", async () => {
  const errFetch = async () =>
    new Response(JSON.stringify({ error: "missing_api_key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  const c = createVouchClient({ apiKey: "k", fetch: errFetch });
  await assert.rejects(
    () => c.getPayeeScore("0x36038e1d712c5e39f35952164ec58ec2b96caee7"),
    (e) => e.code === "missing_api_key",
  );
});
