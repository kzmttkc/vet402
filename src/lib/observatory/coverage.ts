// ============================================================
// §7.4 カバレッジ階層。全 URL を毎日 L1 購入してはならない。
//
//   C0 発見   公開カタログ全件                          日次   掲載の有無のみ
//   C1 生存   直近 30 日に listed または決済があった URL  日次   L0
//   C2 重点   決済帰属あり、または問い合わせの多い URL    6h L0 / 24h L1
//   C3 適合   schema/宣言がある C2                       L1 成功後に L2
//   C4 再検証 売り手異議・判定変更・障害後                即時   異議対象レベル
//
// 新規 URL は C1 から入る。L1 は金額上限と日次バジェットを持つ。バジェットを超えたら
// C2 をサンプリングし、未実施を unverified とする。未実施を pass と書かない。
//
// Vercel Hobby の cron は日次まで。C2 の 6 時間 L0 は管理リポの launchd が
// `?tier=c2` で叩く（scripts/launchd/vet402_c2_probe.sh）。
// ============================================================
import { sql, type SQL } from "drizzle-orm";

export type CoverageTier = "C0" | "C1" | "C2" | "C3" | "C4";

export type TierSignals = {
  listedWithin30d: boolean;
  settledWithin30d: boolean;
  attributedSettlements: number;
  lookups7d: number;
  hasDeclaration: boolean;
  reverifyRequested: boolean;
};

export const LOOKUPS_C2_THRESHOLD = 5;

/** 純関数。上位の階層ほど優先（C4 > C3 > C2 > C1 > C0）。 */
export function tierOf(s: TierSignals): CoverageTier {
  if (s.reverifyRequested) return "C4";
  const c2 = s.attributedSettlements > 0 || s.lookups7d >= LOOKUPS_C2_THRESHOLD;
  if (c2 && s.hasDeclaration) return "C3";
  if (c2) return "C2";
  if (s.listedWithin30d || s.settledWithin30d) return "C1";
  return "C0";
}

/** 各階層の L0 周期（時間）。C0 は L0 を測らない（掲載の有無だけ）。 */
export const L0_INTERVAL_HOURS: Record<CoverageTier, number | null> = {
  C0: null,
  C1: 24,
  C2: 6,
  C3: 6,
  C4: 0,
};

/**
 * L0 候補の WHERE 句（x402_endpoints e）。
 *   c1: active かつ（30 日以内に listed ∨ 30 日以内に決済あり）
 *   c2: 決済帰属（confirmed/probable）あり ∨ 7 日で lookup ≥ 閾値
 * 直近の probe が古い順に並べるのは呼び手（probe-runner）。
 */
export function l0TierWhere(tier: "c1" | "c2"): SQL {
  const settled30d = sql`EXISTS (
    SELECT 1 FROM settlements s WHERE s.endpoint_id = e.id
      AND coalesce(s.block_time, s.observed_at) > now() - interval '30 days')`;
  if (tier === "c1") {
    return sql`e.status = 'active' AND (e.last_seen_at > now() - interval '30 days' OR ${settled30d})`;
  }
  const attributed = sql`EXISTS (
    SELECT 1 FROM settlements s WHERE s.endpoint_id = e.id
      AND s.attribution IN ('confirmed', 'probable')
      AND coalesce(s.block_time, s.observed_at) > now() - interval '30 days')`;
  const lookups = sql`coalesce((
    SELECT sum(n) FROM decision_lookups d WHERE d.endpoint_id = e.id AND d.day > (current_date - 7)::text), 0) >= ${LOOKUPS_C2_THRESHOLD}`;
  return sql`e.status = 'active' AND (${attributed} OR ${lookups})`;
}

/**
 * L1 候補は C2 のみ（決済帰属あり ∨ 問い合わせ多）。宣言ありは C3 として L1 成功後に
 * L2 を必ず行う（l1-runner が l2Schema を判定する）。
 */
export function l1TierWhere(): SQL {
  return l0TierWhere("c2");
}
