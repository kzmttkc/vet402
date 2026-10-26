import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
// 2026-09-29 会計監査 7 周目（低）: acquireLease は取得の例外で「取れた」を返す。取れたと確かめられたときだけ走る。
import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
import { loadWashClassifier } from "@/lib/settlements/context";
import { ingestL1 } from "@/lib/settlements/ingest-l1";
import { ingestPayments } from "@/lib/settlements/ingest-payments";
import { indexEvm } from "@/lib/settlements/index-evm";
import { indexSolana } from "@/lib/settlements/index-solana";
import { indexXrpl } from "@/lib/settlements/index-xrpl";
import { makeChainTransferReader, recoverLateSettlements } from "@/lib/settlements/recover-late";
import { readAuthorizationNonces } from "@/lib/observatory/settlement-verify";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// §7.2 決済索引（日次）。3 経路を順に流す。各段は締切と件数上限を持ち、
// 未読は次回に持ち越す。lease で二重起動を防ぐ（l1-purchase と同じ設計）。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const lease = await acquireLeaseFailClosed("index-settlements", 330);
  if (!lease.acquired && lease.reason === "unverified") {
    return NextResponse.json({ ok: false, error: "lease_unverified" }, { status: 503 });
  }
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "lease_held" });
  }
  // 2026-10-11: 最後の段（Celo の直読み）に渡す締切。maxDuration（300 秒）の 15 秒手前——残りは最後の SQL と応答のぶん。
  const deadlineAt = Date.now() + (maxDuration - 15) * 1000;
  try {
    const classifier = await loadWashClassifier();
    const l1 = await ingestL1();
    const payments = await ingestPayments({ classifier });
    const evm = await indexEvm({ budgetMs: 120_000, classifier });
    const solana = await indexSolana({ budgetMs: 60_000, classifier });
    // XRPL（2026-09-17）: XRPL_RPC_URL が無ければ no-op（skipped）。受取先は 7 つなので短い予算で足りる。
    const xrpl = await indexXrpl({ budgetMs: 20_000, classifier });
    // 2026-09-04 監査 P2: 索引を更新した**あと**に、遅れて決済された settle_failed を
    // 拾って tx へ結びつける（settled とは名乗らせない——照合器が決める）。
    // 2026-09-29: 候補が 2 行以上ある tx は、レシートの nonce で持ち主が 1 行に決まるときだけ貼る。
    // 2026-09-29 第4巡: 索引に無い着金（後からカタログに載った payTo 宛て）は Base のチェーンを直接読む。1 回 20 行まで
    // （読んだ行には印を付け、次からは読まない。溜まった分は一度きりの再照合で流す）。
    // 2026-10-11: Celo の行（応答なしで settle_failed になったが、売り手は決済していた）も Celo のチェーンを直接読む。
    // Base とは別枠で 1 回 20 行まで・CELO_RPC_URL が無ければ読まない・貼るのはレシートの nonce が行の nonce と合う tx だけ。
    // 2026-10-19: BNB（eip155:56）の USD1 も同じ。BNB_RPC_URL が無ければ読まない。額は 18 桁を 6 桁にしてから貼る。
    // 2026-10-22: Arbitrum One（eip155:42161）のネイティブ USDC も同じ。ARBITRUM_RPC_URL が無ければ読まない。
    // 2026-10-26: Avalanche C-Chain（eip155:43114）のネイティブ USDC も同じ。AVALANCHE_RPC_URL が無ければ読まない。
    // 各段の持ち時間の合計: EVM の索引 120 + Solana 60 + XRPL 20 + Base の直読み 45 + Celo の直読み 30 + BNB の直読み 30 + Arbitrum の直読み 30 + Avalanche の直読み 30 = 365 秒。
    // 持ち時間の無い段が長引いた回は、Celo と BNB と Arbitrum と Avalanche の段が deadlineAt の手前で止まる（読まなかった行は次回）。
    const lateSettlements = await recoverLateSettlements({
      readNonces: readAuthorizationNonces,
      readTransfers: makeChainTransferReader(),
      chainReadLimit: 20,
      deadlineAt,
    });
    return NextResponse.json({ ok: true, testWallets: classifier.testWallets.size, l1, payments, evm, solana, xrpl, lateSettlements });
  } catch (error) {
    logServerErrorSafe("cron.index-settlements", error);
    return NextResponse.json({ ok: false, error: "index_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
