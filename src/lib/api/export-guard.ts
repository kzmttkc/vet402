// ============================================================
// 公開 CSV export の負荷の関門（2026-09-29 監査 6 周目・中）。
//
// 攻撃の形: `?cb=<乱数>` を付けると CDN のキャッシュのキーが毎回変わり、毎回関数まで届く（本番で 1 回 2.6 秒・5MB）。
// IP ごとの 6 回/分は IP を増やせば回避できる。
//
//  1. 知らないクエリ・同じ名前の重複は 400（キャッシュのキーを作らせない）。知っている値も正規の形だけ。
//  2. 3 本の export（購入台帳・売り手・L0）全体で、同時に DB を読むのは 1 本まで。共有の枠ストア（ip_rate_limits の
//     1 行）を期限つきの貸し出しとして使う: 空いていれば取り、終わったら返す。関数が途中で落ちても期限（60 秒）で空く。
//     埋まっていれば 503 と Retry-After（CDN のキャッシュに当たる要求はここまで来ない）。
// ============================================================
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isProduction } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/** 知らないクエリ・重複したクエリがあれば 400 の応答、無ければ null。 */
export function rejectUnknownQuery(
  searchParams: URLSearchParams,
  allowed: readonly string[],
  headers: Record<string, string>,
): NextResponse | null {
  const seen = new Set<string>();
  for (const name of searchParams.keys()) {
    if (!allowed.includes(name) || seen.has(name)) {
      return NextResponse.json(
        { error: "invalid_query", allowed: [...allowed] },
        { status: 400, headers },
      );
    }
    seen.add(name);
  }
  return null;
}

/** 全体の貸し出しの行（ip_rate_limits.bucket_key）。IP を含まない（ipBucketKey は触らない）。 */
export const EXPORT_SLOT_KEY = "export-inflight:global";
/** 貸し出しの期限。関数が返さずに落ちても、これだけ待てば空く（export の関数の実行時間の上限より長く）。 */
export const EXPORT_SLOT_LEASE_MS = 60_000;
/** 埋まっていたときの Retry-After（秒）。 */
export const EXPORT_BUSY_RETRY_AFTER_SEC = 5;

let memoryLeaseUntil = 0;

export type ExportSlot = { ok: true; release: () => Promise<void> } | { ok: false; unavailable: boolean };

/**
 * export の同時実行の枠を 1 つ取る（全体で 1 本）。取れたら release を必ず呼ぶ（finally）。
 * DB 不通は取れない側（unavailable）——枠を守れないまま重い問い合わせを流さない。
 */
export async function acquireExportSlot(): Promise<ExportSlot> {
  const db = getDb();
  if (!db) {
    if (isProduction()) return { ok: false, unavailable: true };
    const now = Date.now();
    if (memoryLeaseUntil > now) return { ok: false, unavailable: false };
    memoryLeaseUntil = now + EXPORT_SLOT_LEASE_MS;
    return {
      ok: true,
      release: async () => {
        memoryLeaseUntil = 0;
      },
    };
  }
  const leaseSec = EXPORT_SLOT_LEASE_MS / 1000;
  try {
    // 1 文で「空いている（行が無い・count が 0・期限切れ）なら取る」。取れたときだけ行が返る。
    const raw = await db.execute(sql`
      INSERT INTO ip_rate_limits (bucket_key, count, reset_at)
      VALUES (${EXPORT_SLOT_KEY}, 1, now() + make_interval(secs => ${leaseSec}))
      ON CONFLICT (bucket_key) DO UPDATE SET count = 1, reset_at = now() + make_interval(secs => ${leaseSec})
      WHERE ip_rate_limits.count = 0 OR ip_rate_limits.reset_at <= now()
      RETURNING to_char(reset_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS lease`);
    const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { lease?: unknown }[];
    if (rows.length === 0) return { ok: false, unavailable: false };
    // 返すのは自分の貸し出しだけ（期限切れの後に別の要求が取り直していたら触らない）。期限の時刻を札に使う。
    const lease = String(rows[0].lease ?? "");
    return {
      ok: true,
      release: async () => {
        try {
          await db.execute(sql`
            UPDATE ip_rate_limits SET count = 0
            WHERE bucket_key = ${EXPORT_SLOT_KEY}
              AND to_char(reset_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${lease}`);
        } catch (error) {
          // 返せなくても期限で空く。
          logServerErrorSafe("export_slot.release", error);
        }
      },
    };
  } catch (error) {
    logServerErrorSafe("export_slot.acquire", error);
    return { ok: false, unavailable: true };
  }
}

/** 枠が取れなかったときの応答。 */
export function exportBusyResponse(slot: { unavailable: boolean }, headers: Record<string, string>): NextResponse {
  // error の語はリテラルのまま書く（tests/openapi-error-enum.test.ts が `error: "…"` を拾って enum と照合する）。
  const body = slot.unavailable ? { error: "temporarily_unavailable" } : { error: "export_busy" };
  return NextResponse.json(body, { status: 503, headers: { ...headers, "Retry-After": String(EXPORT_BUSY_RETRY_AFTER_SEC) } });
}
