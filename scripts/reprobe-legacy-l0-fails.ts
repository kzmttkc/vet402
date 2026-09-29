// ============================================================
// 旧規則の公開 fail を今の計器で測り直す（2026-09-29 監査 6 周目・一回もの・再実行＝続きから）。
//
// 対象: 掲載中で、見出しの fail が 2026-09-29 の変更より前の規則で書かれたプローブ行に乗っている出品
// （src/lib/observatory/l0-rule-change.ts）:
//   post_400_422_no_402         未払い POST（本文 `{}`）への 400/422 を no_402 とした行（今は request_shape・unverified）
//   mismatch_values_unrecorded  比べた値を記録していない price_mismatch / metadata_mismatch
//   accepts_invalid_body_cut    4,000 バイトで切って読んだ疑いのある accepts_invalid
// 1 出品 1 要求（cron と同じ probeEndpoint）。公開判定が変わった出品は、プローブ行と訂正ログ
// （reason=reverify・after.trigger=rule_change_reprobe）を 1 文で書く。
//
// 売り手への負荷: 同じ登録ドメインへは同時 1 件・開始の間隔 1 秒以上（--interval-ms は 1000 未満にできない）。
// 最新のプローブが --min-age-hours より新しい出品は飛ばす（cron の直後に続けて叩かない）。
//
// 既定は dry-run（件数・ドメイン・所要時間の見積もりを印字するだけ。外へ要求を出さず、何も書かない）。
//
// Run（本番の DATABASE_URL で）:
//   npx tsx scripts/reprobe-legacy-l0-fails.ts                                   # dry-run
//   npx tsx scripts/reprobe-legacy-l0-fails.ts --apply                        # 実行（既定: 最大 3,000 件・30 分）
//   npx tsx scripts/reprobe-legacy-l0-fails.ts --apply --limit 200 --max-minutes 5   # 小さく試す
// 止め方: Ctrl-C 1 回＝新しい要求を出すのをやめ、出した要求（最長 10 秒）を待って集計を出して終わる。
//         Ctrl-C 2 回＝即終了（書きかけの行は無い——1 出品の書き込みは 1 文）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";
import { MIN_CONSECUTIVE_FAILS_TO_PUBLISH } from "@/lib/observatory/l0-probe";
import { legacyRuleFailKindSql, needsRuleChangeReprobeSql } from "@/lib/observatory/l0-rule-change";
import {
  REPROBE_CONCURRENCY_MAX,
  REPROBE_LIMIT_MAX,
  REPROBE_MAX_MINUTES_MAX,
  REPROBE_MIN_INTERVAL_MS,
  estimateReprobeSeconds,
  selectRuleChangeTargets,
  startRuleChangeReprobe,
} from "@/lib/observatory/l0-rule-change-reprobe";

function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} needs a non-negative number`);
  return v;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = Math.min(Math.max(1, Math.trunc(numArg("--limit", 3000))), REPROBE_LIMIT_MAX);
  const maxMinutes = Math.min(numArg("--max-minutes", 30), REPROBE_MAX_MINUTES_MAX);
  const concurrency = Math.min(Math.max(1, Math.trunc(numArg("--concurrency", 16))), REPROBE_CONCURRENCY_MAX);
  const intervalMs = Math.max(REPROBE_MIN_INTERVAL_MS, numArg("--interval-ms", REPROBE_MIN_INTERVAL_MS));
  const minAgeHours = numArg("--min-age-hours", 6);
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // 理由別の件数（掲載中・掲載終了）。1 出品が 2 種類の行を持てば両方に数える。
  const counts = rowsOf<{ status: string; published_fail: number; targets: number; post: number; mismatch: number; accepts: number }>(
    await db.execute(sql`
      WITH lp AS (
        SELECT e.status,
               (SELECT count(*) = ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} AND bool_and(x.verdict = 'fail')
                  FROM (SELECT q.verdict FROM x402_l0_probes q WHERE q.endpoint_id = e.id
                        ORDER BY q.probed_at DESC LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}) x) AS published_fail,
               ${needsRuleChangeReprobeSql("e")} AS target,
               (SELECT array_agg(${legacyRuleFailKindSql("q")}) FROM (
                  SELECT * FROM x402_l0_probes q0 WHERE q0.endpoint_id = e.id
                  ORDER BY q0.probed_at DESC LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}) q) AS kinds
        FROM x402_endpoints e
      )
      SELECT status,
             count(*) FILTER (WHERE published_fail)::int AS published_fail,
             count(*) FILTER (WHERE target)::int AS targets,
             count(*) FILTER (WHERE target AND 'post_400_422_no_402' = ANY(kinds))::int AS post,
             count(*) FILTER (WHERE target AND 'mismatch_values_unrecorded' = ANY(kinds))::int AS mismatch,
             count(*) FILTER (WHERE target AND 'accepts_invalid_body_cut' = ANY(kinds))::int AS accepts
      FROM lp GROUP BY status ORDER BY status
    `),
  );
  console.log(`${apply ? "[apply]" : "[dry-run]"} published L0 fail resting on a pre-2026-09-29 probe row, by listing status:`);
  for (const c of counts) {
    console.log(
      `  ${c.status}: published_fail=${c.published_fail} targets=${c.targets} ` +
        `(post_400_422_no_402=${c.post} mismatch_values_unrecorded=${c.mismatch} accepts_invalid_body_cut=${c.accepts})`,
    );
  }

  const targets = await selectRuleChangeTargets(limit);
  const est = estimateReprobeSeconds(targets, { concurrency, intervalMs });
  console.log(
    `this run: active targets=${targets.length} (limit ${limit}) domains=${est.byDomain.length} ` +
      `typical_latency=${est.typicalLatencyMs}ms concurrency=${concurrency} interval=${intervalMs}ms/domain`,
  );
  console.log(`  largest domains: ${est.byDomain.slice(0, 8).map(([d, n]) => `${d}=${n}`).join(" ")}`);
  console.log(`  estimated duration ≈ ${Math.ceil(est.seconds / 60)} min (capped by --max-minutes ${maxMinutes})`);
  if (!apply) {
    console.log("(no request sent, nothing written — pass --apply to re-probe)");
    process.exit(0);
  }

  const run = startRuleChangeReprobe({ targets, concurrency, intervalMs, maxMinutes, minAgeHours, log: (l) => console.log(l) });
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals >= 2) {
      console.log("second interrupt: exiting now");
      process.exit(130);
    }
    console.log("interrupt: no new requests; waiting for the ones in flight (Ctrl-C again to exit now)");
    run.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const s = await run.done;
  console.log(
    `done (${s.stoppedBy}) in ${s.elapsedSeconds}s: planned=${s.planned} probed=${s.probed} corrected=${s.corrected} ` +
      `still_resting_on_a_legacy_row=${s.stillRestingOnLegacyRow} skipped_resolved=${s.skippedResolved} ` +
      `skipped_recent=${s.skippedRecent} not_started=${s.notStarted} errors=${s.errors}`,
  );
  console.log(`  published verdict before->after: ${JSON.stringify(s.transitions)}`);
  console.log(`  new probe outcome: ${JSON.stringify(s.newReasons)}`);
  if (s.notStarted > 0 || s.stillRestingOnLegacyRow > 0) {
    console.log(`  run again after ${minAgeHours}h to continue (the C1 cron also puts these first).`);
  }
  process.exit(s.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
