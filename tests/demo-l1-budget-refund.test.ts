// ============================================================
// demo/verify の日次デモ予算は「実購入が成立した時だけ」計上する（2026-09-04 監査 B・P2）。
//
// route.ts は予算トークンを runL1Batch の**前**に取る（原子的な上限のため正しい）。だが
// 購入が成立しなかった場合（L1 が OFF・候補なし・予算拒否・例外・per-IP で拒否）にも
// トークンが減ったままだった。既定 5 回/日なので、成立しない呼び出し 5 回でその日の
// デモが誰にも提供できなくなる。予約→不成立なら返金、で「成立した時だけ計上」にする。
//
// 検証の形: DB 無し（メモリの窓）・DEMO_L1_DAILY_MAX=1・OBSERVATORY_L1_ENABLED 未設定。
// 1 回目は L1 が OFF なので購入は成立しない（200・summary.disabledReason=l1_disabled）。
// 2 回目: 返金されていれば予算は通り、次の関門 per-IP（1 回/日）で 429 rate_limited。
// 返金されていなければ予算で 429 demo_budget_exhausted。この 2 つの error で区別する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";

const ENDPOINT_ID = "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a";

function request() {
  return new Request("http://localhost/api/v1/demo/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpointId: ENDPOINT_ID, level: "l1" }),
  });
}

test("購入が成立しなかった呼び出しは日次デモ予算を消費しない", async () => {
  delete process.env.DATABASE_URL;
  __setDbForTests(null);
  process.env.DEMO_L1_ENABLED = "true";
  process.env.DEMO_L1_DAILY_MAX = "1";
  delete process.env.OBSERVATORY_L1_ENABLED;
  try {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/v1/demo/verify/route");

    const first = await POST(new NextRequest(request()));
    assert.equal(first.status, 200);
    const body1 = (await first.json()) as { summary: { disabledReason: string | null; spentUnitsTotal: string } };
    assert.equal(body1.summary.disabledReason, "l1_disabled");
    assert.equal(body1.summary.spentUnitsTotal, "0");

    const second = await POST(new NextRequest(request()));
    assert.equal(second.status, 429);
    const body2 = (await second.json()) as { error: string };
    assert.equal(
      body2.error,
      "rate_limited",
      "予算が返金されていれば per-IP の 1 回/日で止まる。demo_budget_exhausted なら不成立でも計上している",
    );
  } finally {
    delete process.env.DEMO_L1_ENABLED;
    delete process.env.DEMO_L1_DAILY_MAX;
  }
});
