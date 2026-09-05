// ============================================================
// settled と delivered を分ける定義（2026-09-04 外部監査 E・P0-3）。
//
// 事故: /api/v1/observatory/endpoints/{id}/purchases は api.exa.ai/search を
// 「10/10 settled」と報告し、同じ endpoint の /facts は同じ 10 件を
// n_probe_error 10（HTTP 400）と報告していた。バッジも 10/10 settled を描いた。
// LP §2 は L1 を "Does payment settle and a response arrive?" と定義している——
// 転送は起きたが応答は届いていないので、settled だけを出すのは定義に対して嘘になる。
// 本番実測（2026-09-04）: settled 1,452 のうち 120 件が非 2xx。
//
// だから語を 2 つに割る。settled = 転送の確認。delivered = settled かつ 2xx。
// 判定はここに 1 つだけ置き、SQL 側の述語も同じ定数から作る（2 箇所に書くと片方だけ直る日が来る）。
// Run: npx tsx --test tests/observatory-delivery.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERED_HTTP_MAX,
  DELIVERED_HTTP_MIN,
  deliveredPredicate,
  isDelivered,
} from "@/lib/observatory/delivery";

test("delivered は settled かつ 2xx のときだけ真", () => {
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: 200 }), true);
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: 204 }), true);
});

test("決済は確認できたが壁が 4xx/5xx を返した行は delivered ではない", () => {
  // api.exa.ai/search の実測形（settled ×10・すべて HTTP 400）。
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: 400 }), false);
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: 502 }), false);
});

test("HTTP 応答が記録されていない行は delivered と数えない", () => {
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: null }), false);
});

test("settled 以外は 2xx が返っていても delivered ではない", () => {
  // 品は来たがレシートが無い行（delivered_no_receipt）は決済の確認が取れていない。
  assert.equal(isDelivered({ status: "delivered_no_receipt", httpStatusPaid: 200 }), false);
  assert.equal(isDelivered({ status: "settle_claimed", httpStatusPaid: 200 }), false);
  assert.equal(isDelivered({ status: "settle_failed", httpStatusPaid: 200 }), false);
});

test("2xx の境界は 200 と 299（301 も 199 も含めない）", () => {
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: DELIVERED_HTTP_MIN }), true);
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: DELIVERED_HTTP_MAX }), true);
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: DELIVERED_HTTP_MIN - 1 }), false);
  assert.equal(isDelivered({ status: "settled", httpStatusPaid: DELIVERED_HTTP_MAX + 1 }), false);
});

test("SQL 述語は同じ定数から組まれる（TS と SQL で境界が食い違わない）", () => {
  const p = deliveredPredicate("p");
  assert.ok(p.includes(`p.status = 'settled'`), p);
  assert.ok(p.includes(`p.http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX}`), p);
});

test("別名なしの述語は列名だけを使う（同じ表を FROM 直下で数えるとき用）", () => {
  const p = deliveredPredicate();
  assert.ok(p.includes(`status = 'settled'`), p);
  assert.ok(!p.includes("."), p);
});

test("述語に使える別名は識別子だけ（式を渡して SQL を伸ばせない）", () => {
  assert.throws(() => deliveredPredicate("p; DROP TABLE x402_l1_purchases --"), /alias/i);
});

// ============================================================
// inconclusive（2026-09-05）。
//
// 事故: 支払い後の非 2xx を一律「settled かつ not delivered」として公開し、
// バッジで実名の会社に配っていた。公開台帳 export.csv の全行集計では、
// settled 1,669 行のうち支払い後 4xx/5xx が 180 行、うち 157 行(87%)が 4xx。
// 4xx は HTTP の意味論では「送られた要求が不正」であって、我々は POST に `{}` を
// 送り、売り手の API キーを一切持たずに買う——401 が 11 行あるのがその証拠。
//
// 方法論は既に正しい原則を持っていた（`path_template`: 我々が正しく組めなかった
// URL から返る 400 は我々の限界であって売り手の不履行ではない）。適用範囲が
// URL だけだったのが誤りで、ボディと認証ヘッダにも同じ原則を当てる。
// **行は消さない。判定を保留にして理由を書く。**
// ============================================================
import {
  INCONCLUSIVE_HTTP_MAX,
  INCONCLUSIVE_HTTP_MIN,
  inconclusivePredicate,
  isInconclusive,
} from "@/lib/observatory/delivery";

test("支払い後 4xx は inconclusive（判定保留）", () => {
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 400 }), true);
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 401 }), true);
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 403 }), true);
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 404 }), true);
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 422 }), true);
});

test("5xx は保留にしない——サーバ側の障害は我々の要求の形では説明できない", () => {
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 500 }), false);
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 502 }), false);
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 503 }), false);
});

test("2xx は保留にしない（届いた行を保留に逃がさない）", () => {
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: 200 }), false);
});

test("settled 以外は保留にもならない（金が動いていない行は別の話）", () => {
  assert.equal(isInconclusive({ status: "settle_failed", httpStatusPaid: 400 }), false);
  assert.equal(isInconclusive({ status: "settled", httpStatusPaid: null }), false);
});

test("delivered と inconclusive は排他（同じ行が両方には数えられない）", () => {
  for (const code of [200, 204, 299, 400, 401, 404, 422, 499, 500, 502, null]) {
    const row = { status: "settled", httpStatusPaid: code };
    assert.ok(
      !(isDelivered(row) && isInconclusive(row)),
      `HTTP ${code} が delivered と inconclusive の両方になった`,
    );
  }
});

test("SQL 述語は JS の判定と同じ境界を使う（2 箇所で腐らない）", () => {
  const p = inconclusivePredicate("x");
  assert.ok(p.includes(`BETWEEN ${INCONCLUSIVE_HTTP_MIN} AND ${INCONCLUSIVE_HTTP_MAX}`));
  assert.ok(p.includes("x.status = 'settled'"));
  // delivered の境界と重ならない。
  assert.ok(INCONCLUSIVE_HTTP_MIN > DELIVERED_HTTP_MAX);
});

test("述語の alias は識別子だけ（式を差し込めない）", () => {
  assert.throws(() => inconclusivePredicate("x; DROP TABLE"), /plain identifier/);
  assert.throws(() => deliveredPredicate("x; DROP TABLE"), /plain identifier/);
});
