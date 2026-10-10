import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { getChainScope, getCoverageShare, getObservatoryStats, getObservatoryStatsByChain } from "@/lib/observatory/reader";
import { deliveredRates } from "@/lib/observatory/delivered-rates";
import { isSpendingHalted } from "@/lib/observatory/kill-switch";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/observatory/state — "State of x402", as data.
 *
 * Key-less machine-readable twin of the /observatory/state page: the same
 * aggregate L0/L1 measurements a human reads there, computed by the same
 * readers so the two can never disagree. Facts only — counts with their
 * denominators, no composite score, no evaluative language.
 *
 * Exists so any consumer (a dashboard, an LLM answering "how healthy is
 * x402", the weekly distribution post generator) reads the numbers from one
 * canonical source instead of scraping the HTML table. IP-rate-limited and
 * CDN-cached like the other key-less public paths.
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-state:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  try {
    const [stats, byChain, chainScope, coverage, halt] = await Promise.all([
      getObservatoryStats(),
      getObservatoryStatsByChain(),
      getChainScope(),
      getCoverageShare(),
      // 集計とは別に、毎回読み直す。ObservatoryStats に入れると公開頁側の
      // 300 秒の読み取りキャッシュに載り、止めた直後の 5 分間「止めていない」と
      // 表示し得る。止めた事実は即時に見えなければ意味がない。
      isSpendingHalted(),
    ]);

    return NextResponse.json(
      {
        ...stats,
        byChain,
        /**
         * vet402 自身が L1 の支出を止めているか。true の間は l1 の件数が動かないので、
         * 静かな日と止めている日を取り違えないための鮮度情報（l1.lastAttemptAt と併読する）。
         * **測られる側の状態ではない。** 何を読んでそう決めたか（source）は出さない——
         * 運用の内部事情であって、引用される事実ではない。
         */
        spendingHalted: halt.halted,
        /** Share of active listed endpoints with an L0 measurement in the last 7 days. */
        coverage7d: coverage,
        // The top-level totals count every listing including testnets (Base
        // Sepolia); `byChain` is mainnet-only, matching the HTML page's
        // "Mainnets only" table. State this so a consumer summing byChain and
        // finding it below `totalEndpoints` sees why, rather than a silent gap.
        byChainScope: "mainnet_only",
        // 2026-09-29 監査 5 周目: byChain は「mainnet と分かっている」network だけ。外に出た分を数で出す
        // （sum(byChain) + byChainTestnetEndpoints + sum(byChainUnclassified) = totalEndpoints）。
        byChainTestnetEndpoints: chainScope.testnetEndpoints,
        byChainUnclassified: chainScope.unclassified,
        // 2026-09-29 監査 5 周目: delivered の率を 2 つの分母で並べる（保留を分母に入れた率だけだと誤解を招く）。
        l1Rates: deliveredRates(stats.l1),
        disclaimer:
          "Aggregate L0/L1 measurements over the public x402 discovery catalog. Catalog source: the CDP x402 Bazaar (and equivalent public discovery surfaces). Discovery surfaces vet402 does not read are outside the measured population; a chain can also appear here with a small count because only part of its listings reach this catalog. Absence or a small count is a coverage limit, not a finding. Facts with denominators, not an assessment of any operator. 'unverified' means not machine-checkable, not dead. publishedPass counts endpoints on record whose latest L0 probe passed, including endpoints no longer listed in the catalog, so it can exceed activeEndpoints; publishedPassActive is the part still listed, and publishedPassActiveProbeOlderThan7d is the part of that whose latest probe is more than 7 days old (a pass stands until the next probe). l1.endpointsSettled counts endpoints (listed or not) with at least one settled row and is the sum of l1.endpointsSettledSellerReceipt (at least one settled row whose transaction the seller named in its settlement receipt, settlement_source=seller_claim) and l1.endpointsSettledIndexOnly (every settled row's transaction was found by vet402's own settlements index, settlement_source=vet402_index; the seller returned no receipt). l1.settled is the transfer vet402 re-read on-chain; l1.delivered is a settled attempt whose paid request also answered 2xx. l1.inconclusive counts paid attempts held rather than counted against the seller, split in l1.inconclusiveByReason: settled4xx (the payment settled and the paid request answered 4xx), unsettled4xx (the paid request answered a 4xx other than 402 and no settlement receipt came back — including sellers that validate a request before settling it; since 2026-09-17) and payerUnfunded (a 402 or 5xx during 2026-09-13T00:00Z–2026-09-15T23:49Z, when vet402's own Base payer wallet had run out of USDC; since 2026-09-17). vet402 cannot always form the request a seller expects (no API key of the seller's; a POST body only when the seller declares one), so a 4xx cannot be separated from a request vet402 itself formed wrongly — the same principle the methodology already applied to path_template URLs, extended to the body and the authentication header. l1.inconclusiveSettled is the settled part of l1.inconclusive and is out of the denominator for delivered; settled minus delivered minus inconclusiveSettled is money that moved with no 2xx and no 4xx to explain it. l1.settled is published at two evidence strengths whose counts sum to it: l1.settledNonceBound re-read the signature nonce vet402 itself generated (the EIP-3009 authorization nonce on Base and Arc, our own memo on Solana, the indexed memo of a TIP-20 TransferWithMemo on Tempo, the hash of the signed blob on XRPL), so that transaction belongs to that purchase; l1.settledAmountPayeeOnly matched amount, payee and asset but carries no nonce, because it settled before the nonce binding shipped at 2026-09-04T12:00:00Z. Rows from before that date are not demoted — vet402 does not refute a seller on evidence it does not hold — so read the weaker tier as a weaker claim, not as a finding about the seller. l1.settledTimeWindowOk counts settled rows whose settlement block time falls within -5/+15 minutes of the attempt; l1.settledTimeWindowUnknown counts settled rows with no block time on record. l1.settledLateLinked counts settled rows whose transaction the seller did not name: the paid response carried no settlement receipt, and vet402's own settlements index found the transfer afterwards (payer, payee, exact amount, time window) before the same on-chain re-read; it is a different axis from the two evidence strengths and is not part of their sum. The ledger export marks those rows settlement_source=vet402_index. l1.byChain covers every chain an L1 attempt ran on and sums to the l1 totals. Top-level totals include testnets; the top-level byChain is L0 and mainnet-only (byChainScope): it counts only network ids vet402 knows to be mainnets, byChainTestnetEndpoints counts the known testnets left out, and byChainUnclassified lists, verbatim with their counts, the network ids vet402 cannot name as either (left out of byChain rather than assumed to be mainnets), so sum(byChain) + byChainTestnetEndpoints + sum(byChainUnclassified) = totalEndpoints. l1Rates puts delivered over three denominators side by side: deliveredOfAttemptsPct is l1.delivered / l1.attempts, whose denominator includes the held attempts (l1.inconclusive) and the attempts still awaiting on-chain re-read (l1.awaitingReread); deliveredOfNotHeldPct is l1.delivered / (l1.attempts - l1.inconclusive), whose denominator still includes the awaiting rows; deliveredOfFinalOutcomePct is l1.delivered / (l1.attempts - l1.inconclusive - l1.awaitingReread), the share of attempts with a counted, final outcome that delivered. Percentages have one decimal and are null when the denominator is 0. l1.awaitingReread counts rows at settle_claimed (the seller asserted a settlement and vet402 has not yet re-read it on-chain; the daily re-read runs at 14:00 UTC); l1.awaitingRereadOlderThan1d and l1.awaitingRereadOlderThan7d count those whose attempt is more than 1 and 7 days old, and l1.awaitingRereadOldestAttemptAt is the oldest one. A row stays there while the chain read cannot settle it either way (for example a transaction the RPC does not return yet), so a few rows wait far longer than a day.",
        humanReadable: "https://vet402.com/observatory/state",
        methodology: "https://vet402.com/observatory/methodology",
        // 引用されて初めて配布になる。ライセンスと取得日を本文に入れておかないと、
        // 機械が引いた数字は出所を失う（2026-08-25）。
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        retrievedAt: new Date().toISOString(),
        cite: "KIZUNA Creation. vet402 observatory. Dataset, retrieved {retrievedAt}. https://vet402.com/api/v1/observatory/state",
      },
      {
        headers: {
          ...shared,
          // Recomputed at most daily (the catalog/probe crons) — 15 min shared
          // cache keeps the CDN in front of scans.
          "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800",
        },
      },
    );
  } catch (error) {
    logServerErrorSafe("observatory_state", error);
    return NextResponse.json(
      { error: "observatory_unavailable" },
      { status: 503, headers: perCaller },
    );
  }
}
