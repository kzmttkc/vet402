import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { acquireLease } from "@/lib/cron/lease";
import { loadWashClassifier } from "@/lib/settlements/context";
import { ingestL1 } from "@/lib/settlements/ingest-l1";
import { ingestPayments } from "@/lib/settlements/ingest-payments";
import { indexEvm } from "@/lib/settlements/index-evm";
import { indexSolana } from "@/lib/settlements/index-solana";
import { recoverLateSettlements } from "@/lib/settlements/recover-late";
import { logServerError } from "@/lib/util/log";

// §7.2 決済索引（日次）。3 経路を順に流す。各段は締切と件数上限を持ち、
// 未読は次回に持ち越す。lease で二重起動を防ぐ（l1-purchase と同じ設計）。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const lease = await acquireLease("index-settlements", 330);
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "lease_held" });
  }
  try {
    const classifier = await loadWashClassifier();
    const l1 = await ingestL1();
    const payments = await ingestPayments({ classifier });
    const evm = await indexEvm({ budgetMs: 120_000, classifier });
    const solana = await indexSolana({ budgetMs: 60_000, classifier });
    // 2026-09-04 監査 P2: 索引を更新した**あと**に、遅れて決済された settle_failed を
    // 拾って tx へ結びつける（settled とは名乗らせない——照合器が決める）。
    const lateSettlements = await recoverLateSettlements();
    return NextResponse.json({ ok: true, testWallets: classifier.testWallets.size, l1, payments, evm, solana, lateSettlements });
  } catch (error) {
    logServerError("cron.index-settlements", error);
    return NextResponse.json({ ok: false, error: "index_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
