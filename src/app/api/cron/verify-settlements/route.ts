import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { acquireLease } from "@/lib/cron/lease";
import { runSettlementVerification } from "@/lib/observatory/settlement-verifier";
import { logServerError } from "@/lib/util/log";

// vet402 Observatory — 決済主張のオンチェーン照合（2026-08-23 監査 C-4）。
//
// `settled` を名乗らせる唯一の場所。購入バッチは `settle_claimed` までしか
// 書かず、ここがチェーンを読んで確認できたものだけを `settled` へ昇格させる。
// スコア証拠（observed_purchases）を書くのもここだけ。
//
// 購入（l1-purchase は 12:00 UTC）の**後**に走らせる。確定数を稼ぐためで、
// 日次まで待てば実際の確定数は数千〜数万になり、確定数の要求はタダで買える。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-08-24 監査: 照合も二重起動すると同じ行を2回見に行き、RPC を無駄に叩き、
  // summary が実態とずれる。購入ほど危険ではないが、排他の理由は同じ。
  const lease = await acquireLease("verify-settlements", 330);
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "already_running" }, { status: 409 });
  }

  try {
    // maxDuration 300s に対し予算 240s。1件あたり RPC 3往復ぶんの余裕を見て
    // 残り 8s を切ったら次回へ回す（途中で殺されるより明示的に繰り越す）。
    const summary = await runSettlementVerification({ budgetMs: 240_000 });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    logServerError("cron.verify_settlements", error);
    return NextResponse.json({ ok: false, error: "verify_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
