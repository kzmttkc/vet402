import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { isProduction } from "@/lib/config/env";
import { runIdentityIndexes } from "@/lib/indexer/identity-index-run";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-09-04 監査 D・P1: lib の throw が理由なしの Next 既定 500 になっていた。
  // 理由をログへ残し、{ ok:false, error } を 500 で返す（cron は CRON_SECRET 越しの運用面）。
  try {
    // Production ignores attacker-controlled maxBlocks (RPC burn); use a fixed cap.
    //
    // 2026-10-31: 1 回に読む量を決めるのは、もう maxBlocks ではなく時間の予算
    // （src/lib/indexer/segmented-scan.ts: 170 秒を過ぎたら新しい区切りを始めない・200 秒で
    // 読みかけの区切りを捨てる・270 秒で書き込みの次の文を始めない）。区切りごとに書いて checkpoint するので、予算で止まった回も
    // 進んだ分は残る。以前の 250,000 ブロックを全部読んでから書く形は、10/8 以降 Transfer が
    // 20,000 ブロックに数十万件ある区間で 300 秒に収まらず、毎回殺されて 1 ブロックも残らなかった。
    // maxBlocks は 1 回の RPC の上限としてだけ残す（1,000,000 ブロック = Base の約 23 日）。
    const raw = request.nextUrl.searchParams.get("maxBlocks");
    const requested = raw ? Number(raw) : 1_000_000;
    const maxBlocks = isProduction()
      ? 1_000_000
      : Math.min(1_000_000, Math.max(1_000, Number.isFinite(requested) ? requested : 1_000_000));

    // 所有者索引と WalletSet 索引（2026-08-13・別 scope で FROM_BLOCK から前進）を同じ持ち時間で並べて回す。
    // 追いついたと言えるのは両方が tip に届いたときだけ（caughtUp）。応答には、それぞれが進んだ
    // ブロック数（blocksAdvanced）・予算で止まったか（stoppedByBudget）も出る。
    // 追いつかせ方は scripts/catch-up-owner-index.sh のループ。
    const { status, body, failures } = await runIdentityIndexes({ maxBlocks: BigInt(maxBlocks) });
    for (const failure of failures) logServerErrorSafe("cron.index-owners", failure);
    return NextResponse.json(body, { status });
  } catch (error) {
    logServerErrorSafe("cron.index-owners", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
