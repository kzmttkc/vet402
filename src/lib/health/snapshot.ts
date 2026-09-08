import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { healthSnapshots } from "@/lib/db/schema";
import { instanceId } from "./instance-id";

export type HealthStatus = "ok" | "degraded" | "error";

const THROTTLE_MS = 5 * 60 * 1000;

/**
 * Pure decision: should a new row be written? Real traffic supplies the
 * sampling interval (see the table's own header comment for why there is no
 * cron), so this exists to keep an active site's table from growing one row
 * per request — a status change always writes immediately (an outage must
 * not wait up to 5 minutes to appear), otherwise at most once per THROTTLE_MS.
 */
export function shouldRecordSnapshot(params: {
  now: Date;
  lastSnapshot: { checkedAt: Date; status: string; detail?: string | null } | null;
  currentStatus: HealthStatus;
  currentDetail?: string | null;
}): boolean {
  const { now, lastSnapshot, currentStatus, currentDetail } = params;
  if (!lastSnapshot) return true;
  if (lastSnapshot.status !== currentStatus) return true;
  // 2026-09-08: detail が変わったときも書く。ただし **status が ok でないときだけ**。
  //
  // なぜ条件付きか。ok が続く平常時は全リクエストの大半で、そこで detail の変化
  // （fresh↔cached はリクエスト毎に揺れる）を書き込み条件にすると、表が
  // 1 リクエスト 1 行に膨らむ。これはこの関数が存在する理由そのものに反する。
  //
  // なぜ非 ok では書くか。障害中こそ「scoring が落ちていたのが payee に移った」
  // という遷移が要る情報で、5 分の絞り込みはそれを丸ごと落とす。障害は
  // failure TTL（15 秒）で自己制限がかかるうえ、detail は低カーディナリティに
  // 作ってある——可変値（レイテンシ・インスタンス）は**別列**にあり、
  // ここでは比較しない。だから非 ok でも行数は probe 名 × 状態 × 原因タグで頭打ちになる。
  if (currentStatus !== "ok" && (lastSnapshot.detail ?? null) !== (currentDetail ?? null)) {
    return true;
  }
  return now.getTime() - lastSnapshot.checkedAt.getTime() >= THROTTLE_MS;
}

/**
 * 判定に付随する、公開しない観測値（2026-09-08 追加）。
 * 省略されたときは列が NULL のまま残る——欠測を欠測として残すのが正しい。
 */
export type SnapshotMeta = {
  /** `scoring=... ; payee=...` の 1 行。src/lib/health/probe-detail.ts が組む。 */
  detail?: string | null;
  /** その判定にかかった実測ミリ秒。 */
  latencyMs?: number | null;
};

/**
 * detail / latency_ms / instance を書く現行の経路。
 * 新列がまだ無い DB では undefined_column(42703) で落ちる——呼び出し側が拾う。
 */
async function insertDetailedSnapshot(
  db: NonNullable<ReturnType<typeof getDb>>,
  status: HealthStatus,
  detail: string | null,
  latencyMs: number | null,
): Promise<void> {
  const [last] = await db
    .select({
      checkedAt: healthSnapshots.checkedAt,
      status: healthSnapshots.status,
      detail: healthSnapshots.detail,
    })
    .from(healthSnapshots)
    .orderBy(desc(healthSnapshots.checkedAt))
    .limit(1);
  if (
    !shouldRecordSnapshot({
      now: new Date(),
      lastSnapshot: last ?? null,
      currentStatus: status,
      currentDetail: detail,
    })
  ) {
    return;
  }
  await db.insert(healthSnapshots).values({
    status,
    detail,
    latencyMs,
    // 呼び出し側から渡さない。この行を書いている当のインスタンスの値でなければ
    // 意味が無く、引数にすると別のインスタンスの値を渡せてしまう。
    instance: instanceId(),
  });
}

/** 2026-08-15 時点の形。ALTER を流す前の本番でも /status を空にしないための退避。 */
async function insertLegacySnapshot(
  db: NonNullable<ReturnType<typeof getDb>>,
  status: HealthStatus,
): Promise<void> {
  const [last] = await db
    .select({ checkedAt: healthSnapshots.checkedAt, status: healthSnapshots.status })
    .from(healthSnapshots)
    .orderBy(desc(healthSnapshots.checkedAt))
    .limit(1);
  if (!shouldRecordSnapshot({ now: new Date(), lastSnapshot: last ?? null, currentStatus: status })) {
    return;
  }
  await db.insert(healthSnapshots).values({ status });
}

/**
 * Fire-and-forget from GET /api/health. Never throws into the caller's response.
 *
 * 2026-09-08: コードのデプロイと ALTER の適用は同時にならない（適用は運用者の
 * 判断で別に走る）。新列を書く INSERT はその窓の間 undefined_column で落ちる。
 * 落ちたまま諦めると /status がその期間だけ空白になる——**壊れているのは
 * 記録の詳しさであって、記録する価値ではない**。だから旧い形で 1 度だけ書き直す。
 * 表そのものが無いとき（初回デプロイ）は退避も missing-schema になり、黙って諦める。
 */
export async function recordHealthSnapshotIfDue(
  status: HealthStatus,
  meta: SnapshotMeta = {},
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await insertDetailedSnapshot(db, status, meta.detail ?? null, meta.latencyMs ?? null);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    try {
      await insertLegacySnapshot(db, status);
    } catch (fallbackError) {
      if (isMissingSchemaError(fallbackError)) return; // cold start — 表がまだ無い
      throw fallbackError;
    }
  }
}

export type DaySummary = {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  total: number;
  ok: number;
  degraded: number;
  error: number;
};

/**
 * Buckets snapshots into UTC calendar days. A day with zero rows is simply
 * absent from the result — never synthesized as 100% (or any other number).
 * /status must read "absent" as "not observed", not as "was fine".
 */
export function summarizeByDay(
  rows: readonly { checkedAt: Date; status: string }[],
): DaySummary[] {
  const byDay = new Map<string, DaySummary>();
  for (const row of rows) {
    const date = row.checkedAt.toISOString().slice(0, 10);
    let bucket = byDay.get(date);
    if (!bucket) {
      bucket = { date, total: 0, ok: 0, degraded: 0, error: 0 };
      byDay.set(date, bucket);
    }
    bucket.total += 1;
    if (row.status === "ok") bucket.ok += 1;
    else if (row.status === "degraded") bucket.degraded += 1;
    else if (row.status === "error") bucket.error += 1;
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export type StatusHistory = {
  current: { status: HealthStatus; checkedAt: Date } | null;
  days: DaySummary[];
  /** Earliest row in the whole table (not just the queried window) — grounds "monitoring since". */
  monitoringSince: Date | null;
};

export async function getStatusHistory(windowDays = 30): Promise<StatusHistory> {
  const db = getDb();
  if (!db) return { current: null, days: [], monitoringSince: null };
  try {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ checkedAt: healthSnapshots.checkedAt, status: healthSnapshots.status })
      .from(healthSnapshots)
      .orderBy(desc(healthSnapshots.checkedAt));
    const current = rows[0] ? { status: rows[0].status as HealthStatus, checkedAt: rows[0].checkedAt } : null;
    const inWindow = rows.filter((r) => r.checkedAt >= cutoff);
    const monitoringSince = rows.length > 0 ? rows[rows.length - 1].checkedAt : null;
    return { current, days: summarizeByDay(inWindow), monitoringSince };
  } catch (error) {
    if (isMissingSchemaError(error)) return { current: null, days: [], monitoringSince: null };
    throw error;
  }
}
