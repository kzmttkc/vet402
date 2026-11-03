import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
import { makeChainNonceReader, makeChainTransferReader, recoverLateSettlements } from "@/lib/settlements/recover-late";
import { readAuthorizationNonces, readAuthorizationState } from "@/lib/observatory/settlement-verify";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// 遅延回収のチェーン直読み——Tempo・Arc・Solana のレーン（2026-11-03・数字の監査 結論 #1 型 (a)）。
//
// なぜ index-settlements と分けるか: あちらは索引の段（EVM 120 + Solana 60 + XRPL 20 秒）と Base の直読み（45 秒）の後ろに
// Celo / BNB / Arbitrum / Avalanche の直読みを並べていて、締切（285 秒）までの残りで頭打ちになる。そこへ 3 本足すと、
// 索引が長引いた日は一度も読まれない。ここは自分の 300 秒を持ち、3 本のレーンに 30 秒ずつ（締切で頭打ち）を配る。
// 索引の段（SQL だけ・索引に載った着金を貼る）と売り手の名指した tx の昇格も走るが、どちらも冪等で、同じ日に 2 回走っても
// 貼る行は 1 回しか貼れない（部分一意 index・RECOVERABLE_ROW の読み直し）。
//
// 時刻（vercel.json）: index-settlements（13:00 UTC）の後・verify-settlements（14:00 UTC）の前。貼った行は settle_claimed で、
// 照合器が同じ日に settled にする。読み手: TEMPO_RPC_URL・ARC_RPC_URL・SOLANA_RPC_URL が無いレーンは何も読まない（行を変えない）。
export const maxDuration = 300;

/** この cron が走らせるレーン。index-settlements の lanes と重ねない。 */
const RECOVER_LATE_CHAINS_LANES = ["tempo", "arc", "solana"] as const;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const lease = await acquireLeaseFailClosed("recover-late-chains", 330);
  if (!lease.acquired && lease.reason === "unverified") {
    return NextResponse.json({ ok: false, error: "lease_unverified" }, { status: 503 });
  }
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "lease_held" });
  }
  const deadlineAt = Date.now() + (maxDuration - 15) * 1000;
  try {
    const lateSettlements = await recoverLateSettlements({
      readNonces: makeChainNonceReader({ evm: readAuthorizationNonces }),
      readTransfers: makeChainTransferReader(),
      readAuthorizationState,
      chainReadLimit: 20,
      deadlineAt,
      lanes: [...RECOVER_LATE_CHAINS_LANES],
    });
    return NextResponse.json({ ok: true, lanes: RECOVER_LATE_CHAINS_LANES, lateSettlements });
  } catch (error) {
    logServerErrorSafe("cron.recover-late-chains", error);
    return NextResponse.json({ ok: false, error: "recover_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
