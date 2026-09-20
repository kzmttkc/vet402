// ============================================================
// 鍵の要らない公開口（POST /api/v1/demo/verify）は、停止スイッチの**理由文言**を返さない
// （2026-09-19 横断監査 W3）。
//
// 何が漏れていたか: route.ts は runL1Batch の summary をそのまま JSON にしていた。
// summary.haltReason の中身は kill-switch.ts の
//   `halted_by_operator: <運用者が書いた理由>` か
//   `halt_flag_unreadable: <DB ドライバの error.message>`
// で、前者は運用者のメモ（「Base の購入元が枯れた。○○に連絡するまで止める」のような
// 内部の事情）、後者は接続先やドライバの素の文言。同じルートの 503 の枝は
// 「どの上流が不調かは admin 限定」としてわざと文言を伏せているのに、こちらが素通しだった。
//
// 直しの形: summary は白名簿で写す（publicL1Summary）。L1BatchSummary に列を足すと
// Omit の型が合わなくなって typecheck が落ちるので、「足したら公開してよいか決める」
// が強制される——ゲートに正解を写すのではなく、経路に関門を置く。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { publicL1Summary, type L1BatchSummary } from "@/lib/observatory/l1-runner";
import { __setDbForTests } from "@/lib/db/client";

const HALTED: L1BatchSummary = {
  attempted: 0,
  settled: 0,
  settleFailed: 0,
  deliveredNoReceipt: 0,
  skipped: 0,
  budgetDenied: 0,
  spentUnitsTotal: "0",
  stoppedForDeadline: false,
  notAttempted: 3,
  orphansResolved: 0,
  halted: true,
  haltReason: "halted_by_operator: Base の購入元が枯れた。補充するまで止める（社内連絡先 …）",
  disabledReason: "spending_halted",
  payerUnfunded: 0,
  payerFundsUnreadable: [],
  laneFloor: {},
  laneFloorHostCapped: {},
  xrplFeeOverCap: 0,
  xrplLaneClosed: null,
};

test("publicL1Summary は haltReason を落とし、計測の数字はそのまま通す", () => {
  const out = publicL1Summary(HALTED);
  assert.equal("haltReason" in out, false, "運用者のメモも DB ドライバの文言も公開口には出さない");
  assert.equal(JSON.stringify(out).includes("halted_by_operator"), false);
  // 「止まっている」という事実そのものは隠さない（503 の枝も spending_halted と名乗る）。
  assert.equal(out.halted, true);
  assert.equal(out.disabledReason, "spending_halted");
  assert.equal(out.notAttempted, 3);
  assert.equal(out.spentUnitsTotal, "0");
});

test("公開口の応答（L1 OFF の実走）に haltReason の鍵が存在しない", async () => {
  delete process.env.DATABASE_URL;
  __setDbForTests(null);
  process.env.DEMO_L1_ENABLED = "true";
  process.env.DEMO_L1_DAILY_MAX = "5";
  delete process.env.OBSERVATORY_L1_ENABLED;
  try {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/v1/demo/verify/route");
    const res = await POST(
      new NextRequest(
        new Request("http://localhost/api/v1/demo/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpointId: "5f0c9c5e-2c3a-4b1e-9a4d-8f6b2e1c7d0a", level: "l1" }),
        }),
      ),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { summary: Record<string, unknown> };
    assert.equal("haltReason" in body.summary, false, "route は白名簿を通した summary を返す");
    assert.equal(body.summary.disabledReason, "l1_disabled", "計測の事実は従来どおり返る");
  } finally {
    delete process.env.DEMO_L1_ENABLED;
    delete process.env.DEMO_L1_DAILY_MAX;
  }
});
