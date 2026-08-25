// ============================================================
// 「我々が払って、届かなかった」を判定に効かせる（2026-08-26）。
//
// 見つけた欠陥（本番実測 2026-08-26）:
//   0x36038e1d… 48回払って 48回決済 → 受取軸 76 → **最終 69 WARN**
//   0x76a672…  140回払って  0回決済 → 受取軸 50 → **最終 69 WARN**
// 完璧に届ける相手と、140回受け取って一度も届けない相手が同じ点数だった。
//
// 原因は2つ:
//   1. `scoreL1Receiving` は deliveryCount<=0 のとき 50 を返す。つまり
//      「測っていない」と「測ったが届かなかった」を同じ中立値に潰していた。
//   2. 受取軸の合成が `Math.max(scoreReceiving, scoreL1Receiving)` なので、
//      L1 の記録は**スコアを上げることしかできない**。不履行は構造的に不可視。
// 不履行は `history-flags` に事実として出ているが、そこには
// 「weighting is the caller's」と明記されている——つまり判定には入っていない。
//
// これは製品の主張と正面から矛盾する。「実際に買い、失敗も同じ重みで公開する」
// と言いながら、その失敗が自分の判定を1点も動かしていなかった。
//
// ---- 設計上、意図して守っていること ----
//
// * **未検証を罰しない。** `settle_claimed`（決済を主張されたがオンチェーン照合が
//   まだ）は失敗に数えない。照合の遅れを売り手の落ち度にしない。
// * **1日の障害で断罪しない。** 重い天井は「異なる日」が複数あることを要求する。
//   我々側の一時的な不調や、相手の短時間の停止で BLOCK にしない。
// * **届いた実績が1件でもあれば天井を掛けない。** その相手の評価は正の枝が扱う。
// * 判定に使う status の集合は observatory の PAID_ATTEMPT_STATUSES と一致させる
//   （テストで固定。定義が2箇所に割れるのは、このリポが繰り返してきた欠陥）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { SCORE_THRESHOLDS } from "@/lib/chain/config";

/**
 * 署名して実際に払った試行のうち、**結果が確定している不履行**。
 * `settle_claimed`（照合待ち）は入れない——測っていないものを所見にしない。
 */
export const RESOLVED_NON_SETTLING_STATUSES = [
  "settle_failed",
  "settle_claim_refuted",
  "settle_claimed_unverifiable",
  "delivered_no_receipt",
] as const;

export type L1SettlementRecord = {
  /** オンチェーンで確認できた決済の件数。 */
  settled: number;
  /** 結果が確定している不履行の件数（照合待ちは含まない）。 */
  resolvedNonSettling: number;
  /** 不履行があった「異なる日」の数（UTC）。1日の障害と継続的な不履行を分ける。 */
  nonSettlingDays: number;
  /** 照合待ちの件数。開示のためだけに持つ（判定には使わない）。 */
  pendingVerification: number;
};

export const EMPTY_L1_SETTLEMENT_RECORD: L1SettlementRecord = {
  settled: 0,
  resolvedNonSettling: 0,
  nonSettlingDays: 0,
  pendingVerification: 0,
};

/**
 * 重度: 20件以上の不履行が3日以上にわたり、決済は1件も無い。
 * これは BLOCK の帯（warn 未満）。我々が実費で140回払って一度も届かなかった相手を
 * 「未知の相手」と同点にしないための線。
 */
export const L1_NONDELIVERY_SEVERE_CEILING = SCORE_THRESHOLDS.warn - 1;
/** 中度: 5件以上・2日以上。ALLOW には遠いが断罪もしない。 */
export const L1_NONDELIVERY_MODERATE_CEILING = 50;
/** 軽度: 1〜4件。凹みであって断罪ではない（相手の一時的な停止も同じ形に見える）。 */
export const L1_NONDELIVERY_LIGHT_CEILING = 65;

export const SEVERE_MIN_FAILURES = 20;
export const SEVERE_MIN_DAYS = 3;
export const MODERATE_MIN_FAILURES = 5;
export const MODERATE_MIN_DAYS = 2;

/**
 * 「払ったのに届かなかった」記録から、最終スコアの天井を出す。
 * 100 は「この理由では天井を掛けない」の意。
 */
export function nonDeliveryCeiling(rec: L1SettlementRecord): number {
  // 一度でも届いていれば、その相手の評価は正の枝（scoreL1Receiving）が扱う。
  if (rec.settled > 0) return 100;
  // 払っていない、または結果が確定していない = 所見が無い。中立。
  if (rec.resolvedNonSettling <= 0) return 100;

  if (rec.resolvedNonSettling >= SEVERE_MIN_FAILURES && rec.nonSettlingDays >= SEVERE_MIN_DAYS) {
    return L1_NONDELIVERY_SEVERE_CEILING;
  }
  if (rec.resolvedNonSettling >= MODERATE_MIN_FAILURES && rec.nonSettlingDays >= MODERATE_MIN_DAYS) {
    return L1_NONDELIVERY_MODERATE_CEILING;
  }
  return L1_NONDELIVERY_LIGHT_CEILING;
}

/** 天井が掛かった理由（機械可読・呼び手が分岐できるように）。 */
export function nonDeliveryReason(rec: L1SettlementRecord): string | null {
  const ceiling = nonDeliveryCeiling(rec);
  if (ceiling >= 100) return null;
  return ceiling === L1_NONDELIVERY_SEVERE_CEILING
    ? "paid_never_settled_sustained"
    : ceiling === L1_NONDELIVERY_MODERATE_CEILING
      ? "paid_never_settled_repeated"
      : "paid_never_settled";
}

/**
 * この payee へ vet402 が実際に払った記録。`pay_to` は**実際に払った相手**で、
 * カタログ申告値ではない（history-flags は申告側で数えており、別の事実）。
 *
 * 読めなければ空を返す（degrade はするが嘘はつかない）。空は「所見なし」であって
 * 「問題なし」ではない——天井を掛けないだけで、他の関門はそのまま効く。
 */
export async function getL1SettlementRecord(payee: string): Promise<L1SettlementRecord> {
  const db = getDb();
  if (!db) return EMPTY_L1_SETTLEMENT_RECORD;
  const addr = payee.startsWith("0x") ? payee.toLowerCase() : payee;
  try {
    const raw = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'settled')::int AS settled,
        count(*) FILTER (WHERE status = ANY(${sql.raw(
          `ARRAY[${RESOLVED_NON_SETTLING_STATUSES.map((s) => `'${s}'`).join(",")}]`,
        )}))::int AS resolved_non_settling,
        count(DISTINCT (attempted_at AT TIME ZONE 'utc')::date) FILTER (
          WHERE status = ANY(${sql.raw(
            `ARRAY[${RESOLVED_NON_SETTLING_STATUSES.map((s) => `'${s}'`).join(",")}]`,
          )})
        )::int AS non_settling_days,
        count(*) FILTER (WHERE status = 'settle_claimed')::int AS pending
      FROM x402_l1_purchases
      WHERE lower(pay_to) = ${addr}
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
      string,
      unknown
    >[];
    const r = rows[0] ?? {};
    return {
      settled: Number(r.settled ?? 0),
      resolvedNonSettling: Number(r.resolved_non_settling ?? 0),
      nonSettlingDays: Number(r.non_settling_days ?? 0),
      pendingVerification: Number(r.pending ?? 0),
    };
  } catch {
    return EMPTY_L1_SETTLEMENT_RECORD;
  }
}
