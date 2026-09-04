import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { logServerError } from "@/lib/util/log";
import { isProduction } from "@/lib/config/env";
import { indexAgentWallets } from "@/lib/indexer/agent-wallet-indexer";
import { indexOwnerAgents } from "@/lib/indexer/owner-indexer";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-09-04 監査 D・P1: lib の throw が理由なしの Next 既定 500 になっていた。
  // 理由をログへ残し、{ ok:false, error } を 500 で返す（cron は CRON_SECRET 越しの運用面）。
  try {
    // Production ignores attacker-controlled maxBlocks (RPC burn); use default chunk.
    // 40k blocks took ~6s end-to-end once GET_LOGS_CHUNK_BLOCKS/DELAY_MS were
    // fixed (2026-07-22 incident — stale values from the old rate-limited RPC
    // key were forcing hundreds of tiny sequential chunks). 250k gives wide
    // margin under the 300s budget while actually outpacing Base's ~43k
    // blocks/day production rate enough to close the historical backlog
    // within a handful of daily (Hobby-plan-capped) runs instead of never.
    const raw = request.nextUrl.searchParams.get("maxBlocks");
    const requested = raw ? Number(raw) : 250_000;
    const maxBlocks = isProduction()
      ? 250_000
      : Math.min(500_000, Math.max(1_000, Number.isFinite(requested) ? requested : 250_000));

    const result = await indexOwnerAgents({
      maxBlocks: BigInt(maxBlocks),
    });

    // WalletSet 索引（2026-08-13）。別 scope で FROM_BLOCK から前進する——所有者側の
    // scope はすでに tip なので、相乗りさせると運用ウォレットの履歴が永久に埋まらない。
    // これが埋まるまで wallet 解決は fail-closed で unavailable を返す（ハングよりは
    // 正直な失敗）。追いつかせ方は scripts/catch-up-owner-index.sh のループ。
    const walletIndex = await indexAgentWallets({
      maxBlocks: BigInt(maxBlocks),
    });

    return NextResponse.json({
      ok: true,
      ...result,
      // 追いついたと言えるのは両方が tip に届いたときだけ。catch-up スクリプトは
      // この 1 フラグでループを止める。
      caughtUp: result.caughtUp && walletIndex.caughtUp,
      ownerCaughtUp: result.caughtUp,
      walletIndex,
    });
  } catch (error) {
    logServerError("cron.index-owners", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
