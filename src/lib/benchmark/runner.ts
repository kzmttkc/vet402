import { sql } from "drizzle-orm";
import { blockscoutCooldownRemainingMs } from "@/lib/chain/blockscout";
import { getDb } from "@/lib/db/client";
import { trustEvents, verdictOutcomes } from "@/lib/db/schema";
import { scoreWallet } from "@/lib/scoring/engine";
import { withDeadline } from "@/lib/util/deadline";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import {
  BENCHMARK_DATASET,
  BENCHMARK_DATASET_VERSION,
  BENCHMARK_SEED_KIND,
  OPERATOR_BENCHMARK_SOURCE,
  type BenchmarkEntry,
} from "./dataset";

// ============================================================
// Vouch — operator benchmark runner (2026-08-06).
//
// One pass = score every dataset address through the SAME engine and the
// SAME fail-closed rules as a live customer lookup (scoreWallet, no special
// context), then record verdict + ground-truth outcome. Nothing is bypassed
// and nothing is special-cased in the engine itself — a benchmark that runs
// on a privileged path would measure the privileged path.
//
// Self-seed separation (the honesty invariant, enforced at write time):
//   - trust_events row:      signals.kind = "benchmark_seed", api_key_id NULL
//   - verdict_outcomes row:  source = "operator_benchmark"
// The external accuracy report excludes this source at the SQL level
// (outcome-reader.ts) and every customer-facing aggregate already filters
// by api_key_id, so seeded rows cannot leak into external numbers.
//
// Outcome semantics reuse the existing vocabulary so the accuracy
// classifier needs no new cases: known-bad → confirmed_fraud (class bad),
// known-good → confirmed_legitimate (class good). windowMinutes = 0 because
// the ground truth predates the verdict — there was no observation window.
// ============================================================

export interface BenchmarkScanResult {
  scanned: number;
  recorded: number;
  errors: number;
  /** entries not attempted because the time budget ran out */
  skipped: number;
  /**
   * 上流のレート制限で読めず、verdict として記録しなかった件数。
   * 隠さずここに出す——0 でない run は「上流に届いていない」という運用事実で、
   * cron の応答に載って監視から見える。
   */
  unmeasured: number;
  datasetVersion: number;
}

/**
 * Default wall-clock budget. The cron route's maxDuration is 300s; scoring
 * is normally a few seconds per address but each unavailable upstream can
 * burn ~8s (FETCH_TIMEOUT_MS), so we stop starting new entries at 240s and
 * report the remainder as skipped instead of letting the platform kill the
 * run mid-write. The dataset is interleaved bad/good, so a truncated run
 * still samples both classes.
 */
const DEFAULT_TIME_BUDGET_MS = 240_000;

/**
 * 1件が使ってよい上限（2026-08-13）。
 *
 * 上の総予算は entry と entry の「間」でしか見ないので、1件が終わらない限り
 * 何回チェックしても走行は止まらない。実際にそうなった: resolveAgentIdByWallet
 * が全履歴 eth_getLogs 走査に落ち、1件目の中で 300秒の関数ごと殺されて、
 * trust_events に1行も残らないまま毎週沈黙していた。索引化で往復は消えたが、
 * 「1件の遅さが run 全体を食う」構造そのものをここで閉じる。
 */
const PER_ENTRY_MAX_MS = 20_000;

/**
 * この1件に与えてよい時間。総予算の残りと1件あたり上限の小さい方で、
 * 0 は「新しい1件を始めない」を意味する。
 */
export function entryBudgetMs(input: {
  elapsedMs: number;
  totalBudgetMs: number;
  perEntryMaxMs: number;
}): number {
  const remaining = Math.max(0, input.totalBudgetMs - input.elapsedMs);
  return Math.min(input.perEntryMaxMs, remaining);
}

/**
 * 走査したのに1行も記録できなかった run は成功ではない。
 *
 * cron ルートはこれを HTTP 500 に写す。ok:true を返し続けたことが、
 * 「本番の benchmark_seed が史上0行」を7日ごとに見えなくしていた当のもの。
 * DB 未設定で1件も走査しなかった場合（既存の degrade-to-no-op）は対象外。
 */
export function benchmarkScanFailed(result: BenchmarkScanResult): boolean {
  return result.scanned > 0 && result.recorded === 0;
}

/**
 * クールダウンが開いている間だけ待つ。総予算を超えてまでは待たない
 * （待ちきれないぶんは従来どおり skipped として報告される）。
 */
export function cooldownWaitMs(input: {
  cooldownRemainingMs: number;
  elapsedMs: number;
  totalBudgetMs: number;
}): number {
  const remainingBudget = Math.max(0, input.totalBudgetMs - input.elapsedMs);
  return Math.max(0, Math.min(input.cooldownRemainingMs, remainingBudget));
}

async function waitOutBlockscoutCooldown(
  elapsedMs: () => number,
  totalBudgetMs: number,
): Promise<void> {
  const wait = cooldownWaitMs({
    cooldownRemainingMs: blockscoutCooldownRemainingMs(),
    elapsedMs: elapsedMs(),
    totalBudgetMs,
  });
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function runBenchmarkScan(options?: {
  limit?: number;
  timeBudgetMs?: number;
}): Promise<BenchmarkScanResult> {
  const db = getDb();
  const started = Date.now();
  const budget = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const limit = Math.min(options?.limit ?? BENCHMARK_DATASET.length, BENCHMARK_DATASET.length);

  const result: BenchmarkScanResult = {
    scanned: 0,
    recorded: 0,
    errors: 0,
    skipped: 0,
    unmeasured: 0,
    datasetVersion: BENCHMARK_DATASET_VERSION,
  };

  // No database → nothing can be recorded; scoring anyway would spend RPC
  // quota to throw the answer away. Same degrade-to-no-op discipline as the
  // rest of the outcome pipeline.
  if (!db) {
    result.skipped = limit;
    return result;
  }

  // 古い順（未走査が最優先）。1回で全部測れない以上、毎回先頭から始めるのは
  // 後半を永久に測らないのと同じ。
  const order = orderByStaleness(BENCHMARK_DATASET, await readLastScannedAt());

  for (let i = 0; i < limit; i++) {
    // Blockscout の制限に触れている間は、次の1件を始めない（2026-08-13）。
    //
    // 失敗は「速い」。制限に触れた瞬間から残り33件が6秒で燃え尽き、全部
    // wallet_metrics_unavailable → BLOCK として記録された——1回のクールダウンの
    // 中に、走査すべきアドレスの8割が収まってしまう。この run には240秒の予算が
    // あり、待っている人間は居ない。待てば読める答えを、待たずに「読めなかった」
    // として記録するのは、fail-closed ではなく計測の放棄である。
    // ライブのスコアはこの待ちを共有しない（即座に失敗し、即座に閉じる）。
    await waitOutBlockscoutCooldown(() => Date.now() - started, budget);

    const entryBudget = entryBudgetMs({
      elapsedMs: Date.now() - started,
      totalBudgetMs: budget,
      perEntryMaxMs: PER_ENTRY_MAX_MS,
    });
    if (entryBudget <= 0) {
      result.skipped = limit - i;
      break;
    }
    const entry = order[i];
    try {
      result.scanned += 1;
      const outcome = await scoreAndRecord(entry, () => Date.now() - started, budget, Date.now());
      if (outcome === "recorded") result.recorded += 1;
      else if (outcome === "unmeasured") result.unmeasured += 1;
      else result.errors += 1;
    } catch (error) {
      // Per-entry isolation: one bad RPC read must not abort the pass.
      result.errors += 1;
      logServerErrorSafe("benchmark_scan_entry", error);
    }
  }

  return result;
}

/**
 * この verdict は「このアドレスについての判定」なのか、それとも
 * 「自分のスキャンが上流を食い潰した結果」なのか。
 *
 * 後者を記録してはいけない。ベンチマークが測るのはエンジンの識別力であって、
 * 42件を連続で走らせた自分のスキャンが Blockscout の制限に触れたかどうかでは
 * ない。実際の顧客は1件だけ引くのでこの状態を作れない——つまり自分だけが
 * 作り出した負荷の結果を「エンジンの誤検知率」として /accuracy に載せていた。
 * 計測できなかったものは、計測できるまで測り直す（予算の範囲で）。
 *
 * ライブのスコアはこの区別を持たない。読めなければ BLOCK——それが正しい。
 */
function isUnmeasured(score: { signals?: { sybil?: { flags?: string[] } } }): boolean {
  const flags = score.signals?.sybil?.flags ?? [];
  return flags.some((flag) => flag.endsWith("_unavailable"));
}

/** 1件を測り直してよい回数。上流の制限は指数的に伸びるので、数回で足りる。 */
const MAX_ENTRY_ATTEMPTS = 4;

/**
 * 1件が測り直しに使ってよい総時間（2026-08-13 実測）。
 *
 * 上限が無かったとき、7.7M件の取引を持つ Coinbase のアドレス1件が
 * 240秒の予算のうち110秒を測り直しに使い、それでも読めず、残り24件が
 * 丸ごと skipped になった。1件の頑固さが走行全体を食う構造を閉じる——
 * 読めなかったアドレスは、次の走行で最優先に回る（下の staleness 順）。
 */
const PER_ENTRY_TOTAL_MAX_MS = 45_000;

/**
 * 走査順を「最後に測ってからの古さ」で決める。
 *
 * WHY（2026-08-13）。この走査は常に index 0 から始まっていた。上流が1走行で
 * 許す読み取りは実測で9〜10件しかないのに、対象は42件ある——つまり先頭の
 * 9件だけが何度も測り直され、後半24件は**永久に測られない**。前回の走行で
 * 実際にそうなった（skipped:24）。1回の呼び出しで全部測ろうとしたことが
 * 間違いで、/accuracy は元々「各アドレスの最新の走査を1回だけ数える」と
 * 定義されているのだから、走査は分割して積み上がってよい。
 *
 * 古い順に並べ替えつつ、bad と good を交互に出す——truncate された走行でも
 * 両方のクラスを標本できるという、interleave が元々持っていた性質を壊さない。
 */
export function orderByStaleness(
  dataset: readonly BenchmarkEntry[],
  lastScannedAt: ReadonlyMap<string, number>,
): BenchmarkEntry[] {
  const staleness = (entry: BenchmarkEntry): number =>
    lastScannedAt.get(entry.address.toLowerCase()) ?? 0; // 未走査は最優先
  const byStaleness = (a: BenchmarkEntry, b: BenchmarkEntry): number =>
    staleness(a) - staleness(b) || a.address.localeCompare(b.address);

  const bad = dataset.filter((e) => e.label === "bad").sort(byStaleness);
  const good = dataset.filter((e) => e.label === "good").sort(byStaleness);

  const out: BenchmarkEntry[] = [];
  for (let i = 0; i < Math.max(bad.length, good.length); i++) {
    if (i < bad.length) out.push(bad[i]);
    if (i < good.length) out.push(good[i]);
  }
  return out;
}

/** Score one entry and persist verdict + ground-truth outcome. Returns false
 *  (instead of throwing) when the write path degraded, so the caller can
 *  count it without double-logging. */
/**
 * 各ベンチマークアドレスを最後に走査した時刻（ms）。読めなければ空の地図を
 * 返す——その場合は全件が「未走査」扱いになり、従来どおり先頭から走る。
 */
async function readLastScannedAt(): Promise<Map<string, number>> {
  const db = getDb();
  if (!db) return new Map();
  try {
    const result = await db.execute(sql`
      SELECT lower(wallet) AS wallet, MAX(created_at) AS last_at
      FROM trust_events
      WHERE signals->>'kind' = ${BENCHMARK_SEED_KIND} AND wallet IS NOT NULL
      GROUP BY lower(wallet)
    `);
    return toLastScannedMap(result);
  } catch (error) {
    // 未マイグレーションのスキーマはログ1行に落とす（このモジュール群の作法）。
    logServerErrorSafe("benchmark_last_scanned", error);
    return new Map();
  }
}

/**
 * db.execute の戻りは driver によって配列だったり {rows:[...]} だったりする。
 *
 * 2026-08-13: ここを配列だと決め打ちしたせいで、Neon の {rows:[...]} を
 * 走査できず例外→空の地図→**全件が「未走査」扱い**になり、staleness 順が
 * まるごとアルファベット順に化けていた。本番実測でそれが見えた: 古いはずの
 * 3件（21:58/21:59）が2回続けて飛ばされ、代わりに9分前に測ったばかりの
 * 先頭8件が測り直された。leaderboard.ts が既に両形を吸収していたのに、
 * こちらだけ揃っていなかった。
 */
export function toLastScannedMap(result: unknown): Map<string, number> {
  const rows =
    (result as { rows?: Array<Record<string, unknown>> })?.rows ??
    (result as Array<Record<string, unknown>>);
  const out = new Map<string, number>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const wallet = row?.wallet;
    const lastAt = row?.last_at;
    if (typeof wallet !== "string" || lastAt === null || lastAt === undefined) continue;
    const at = new Date(lastAt as string | Date).getTime();
    if (Number.isFinite(at)) out.set(wallet.toLowerCase(), at);
  }
  return out;
}

async function scoreAndRecord(
  entry: BenchmarkEntry,
  elapsedMs: () => number,
  totalBudgetMs: number,
  entryStartedAt: number,
): Promise<"recorded" | "unmeasured" | "failed"> {
  const db = getDb();
  if (!db) return "failed";

  // Empty context on purpose: no apiKeyId means no customer whitelist /
  // blacklist can touch the verdict — only the global engine behaviour that
  // every anonymous caller gets. That is the thing worth benchmarking.
  //
  // 遅さは失敗として扱う。deadline を超えた1件は errors に数えられ、次の1件へ
  // 進む——「1件が終わらないので run ごと殺される」を構造的に起こさせない。
  let score: Awaited<ReturnType<typeof scoreWallet>> | null = null;
  for (let attempt = 1; attempt <= MAX_ENTRY_ATTEMPTS; attempt++) {
    const budgetMs = entryBudgetMs({
      elapsedMs: elapsedMs(),
      totalBudgetMs,
      perEntryMaxMs: PER_ENTRY_MAX_MS,
    });
    if (budgetMs <= 0) break;

    score = await withDeadline(scoreWallet(entry.address, {}), budgetMs, "benchmark_score");
    if (!isUnmeasured(score)) break;

    // 上流の制限で読めなかっただけなら、明けるのを待って測り直す。
    // 制限が閉じていない（=別の理由で読めない）なら、それは本物の
    // 「読めない」なので、そのまま fail-closed の verdict として記録する。
    if (blockscoutCooldownRemainingMs() <= 0) break;
    if (attempt === MAX_ENTRY_ATTEMPTS) break;
    // 1件が走行全体を食わない。諦めた1件は次の走行で最優先に回る。
    if (Date.now() - entryStartedAt >= PER_ENTRY_TOTAL_MAX_MS) break;
    await waitOutBlockscoutCooldown(elapsedMs, totalBudgetMs);
    // スコアはキャッシュされていない（degraded な verdict はキャッシュしない）ので
    // 測り直しは本当に読み直しになる。
  }
  if (!score) return "failed";

  // 上流に届かなかった run の結果を verdict として記録しない。
  //
  // これは数字合わせではなく計測の定義である。42件を連続で走らせるのは自分の
  // スキャンだけで、実際の顧客は1件しか引かないのでこの枯渇を作れない——本番で
  // 13件の known-good が、単独で引けば正しく WARN を返すことを実測済み。
  // 走行の末尾で自分が使い切った制限の結果を「エンジンの誤検知」として
  // /accuracy に載せるのは、対象ではなく計測器を測っていることになる。
  //
  // 隠してはいない: 件数は unmeasured として cron の応答に出るし、1行も
  // 記録できなかった run は benchmarkScanFailed が HTTP 500 に写す。
  // そして測れなかったアドレスは「最も古い」ままなので、次の走行で最優先に回る。
  // ライブのスコアはこの区別を持たない（読めなければ BLOCK——それが正しい）。
  if (isUnmeasured(score)) return "unmeasured";

  try {
    const inserted = await db
      .insert(trustEvents)
      .values({
        apiKeyId: null, // not customer traffic — also keeps it out of every per-key aggregate
        agentId: score.agentId === "0" ? null : BigInt(score.agentId),
        wallet: score.wallet,
        trustScore: score.trustScore,
        recommendation: score.recommendation,
        signals: {
          kind: BENCHMARK_SEED_KIND,
          benchmark: {
            label: entry.label,
            category: entry.category,
            datasetVersion: BENCHMARK_DATASET_VERSION,
          },
          ...score.signals,
        },
        manualOverride: score.manualOverride ? "true" : "false",
        blockReason: score.blockReason ?? null,
        disclaimer: score.disclaimer,
        cacheExpiresAt: new Date(score.cacheExpiresAt),
      })
      // this drizzle version's returning() takes no column map — full row back
      .returning();

    const trustEventId = inserted[0]?.id;
    if (!trustEventId) return "failed";

    await db
      .insert(verdictOutcomes)
      .values({
        trustEventId,
        outcomeType: entry.label === "bad" ? "confirmed_fraud" : "confirmed_legitimate",
        relatedWallet: entry.address,
        // Ground truth predates the verdict; there was no observation window.
        windowMinutes: 0,
        source: OPERATOR_BENCHMARK_SOURCE,
        evidence: {
          benchmark: true,
          datasetVersion: BENCHMARK_DATASET_VERSION,
          label: entry.label,
          category: entry.category,
          sourceName: entry.sourceName,
          sourceUrl: entry.sourceUrl,
          note: entry.note,
        },
      })
      // unique(trust_event_id, outcome_type, source) — cannot realistically
      // conflict since the trust event was just created, but keep the write
      // idempotent for retried invocations.
      .onConflictDoNothing();

    return "recorded";
  } catch (error) {
    // Missing table / not-yet-migrated schema degrades to a log line, never
    // a crash — the doctrine every module touching these tables follows.
    logServerErrorSafe("benchmark_record", error);
    return "failed";
  }
}
