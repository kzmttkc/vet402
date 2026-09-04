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
