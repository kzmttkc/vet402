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
import { getDb } from "@/lib/db/client";
import { SETTLEMENT_DAY, UTC_TODAY, withDailyFallback } from "@/lib/settlements/rollup";
import { isPathTemplate, notPathTemplateSql } from "./path-template";

export type CoverageTier = "C0" | "C1" | "C2" | "C3" | "C4";

export type TierSignals = {
  listedWithin30d: boolean;
  settledWithin30d: boolean;
  attributedSettlements: number;
  lookups7d: number;
  hasDeclaration: boolean;
  reverifyRequested: boolean;
  /**
   * 2026-09-02 監査 A1: 未置換パスパラメータの URL（isPathTemplate）。正しい要求を
   * 作れないので C1〜C3 に入れない（日次枠を使わない）。C4 だけは残す。
   */
  pathTemplate?: boolean;
};

export const LOOKUPS_C2_THRESHOLD = 5;

/** 純関数。上位の階層ほど優先（C4 > C3 > C2 > C1 > C0）。 */
export function tierOf(s: TierSignals): CoverageTier {
  if (s.reverifyRequested) return "C4";
  if (s.pathTemplate) return "C0";
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
 * 階層判定が見る決済の窓（UTC の丸ごと日数）。センサス（census.ts）と同じ 30 日。
 *
 * 2026-09-04 W16: 生行 `settlements` は RAW_RETENTION_DAYS 日しか残らない
 * （rollup.ts）。生行だけを見る 30 日述語は、畳んだ瞬間に窓が 7 日へ縮む——
 * **例外も警告も出ない**。C2 だった endpoint が C1 に落ち、L1 の対象から静かに
 * 消える。だから読む側は必ず「生行 ∪ 日次集約」で数える（census.ts と同じ方式）。
 * 1 件の決済がこの 2 つに同時に載る瞬間は無い（rollup が単一文で「消して畳む」）
 * ので、OR で足しても二重には数えない。
 *
 * 窓の単位を UTC の丸ごと日にしたのは、集約が日単位でしか時刻を持たないから。
 * センサスの定義文（CENSUS_DEFINITION）と同じ規則に揃えた。
 */
export const SETTLEMENT_WINDOW_DAYS = 30;

/** 窓の内側の生行（畳まれた日はここに残っていない）。 */
const settledRaw = (extra: SQL) => sql`EXISTS (
    SELECT 1 FROM settlements s WHERE s.endpoint_id = e.id ${extra}
      AND ${SETTLEMENT_DAY} > ${UTC_TODAY} - ${SETTLEMENT_WINDOW_DAYS}::int)`;
/** 窓の内側の日次集約（畳まれた日はここに居る）。 */
const settledDaily = (extra: SQL) => sql`EXISTS (
    SELECT 1 FROM settlement_daily sd WHERE sd.endpoint_id = e.id ${extra}
      AND sd.day > ${UTC_TODAY} - ${SETTLEMENT_WINDOW_DAYS}::int)`;

const ATTRIBUTED_RAW: SQL = sql`AND s.attribution IN ('confirmed', 'probable')`;
const ATTRIBUTED_DAILY: SQL = sql`AND sd.attribution IN ('confirmed', 'probable')`;

/**
 * 30 日以内に決済があったか（生行 ∪ 集約）。
 * `daily=false` は `settlement_daily` がまだ無い環境（コードだけ先に本番へ出て
 * DDL が未実行）への退避。呼び手が withDailyFallback で切り替える。
 */
export function settledWithinWindowSql(daily = true): SQL {
  const raw = settledRaw(sql``);
  return daily ? sql`(${raw} OR ${settledDaily(sql``)})` : raw;
}

/** 30 日以内に帰属（confirmed/probable）付きの決済があったか（生行 ∪ 集約）。 */
export function attributedWithinWindowSql(daily = true): SQL {
  const raw = settledRaw(ATTRIBUTED_RAW);
  return daily ? sql`(${raw} OR ${settledDaily(ATTRIBUTED_DAILY)})` : raw;
}

/**
 * L0 候補の WHERE 句（x402_endpoints e）。
 *   c1: active かつ（30 日以内に listed ∨ 30 日以内に決済あり）
 *   c2: 決済帰属（confirmed/probable）あり ∨ 7 日で lookup ≥ 閾値
 * どちらもパステンプレート URL（path-template.ts）を除く——tierOf の pathTemplate と同じ。
 * 直近の probe が古い順に並べるのは呼び手（probe-runner）。
 */
export function l0TierWhere(tier: "c1" | "c2", daily = true): SQL {
  if (tier === "c1") {
    return sql`e.status = 'active' AND ${notPathTemplateSql()} AND (e.last_seen_at > now() - interval '30 days' OR ${settledWithinWindowSql(daily)})`;
  }
  const lookups = sql`coalesce((
    SELECT sum(n) FROM decision_lookups d WHERE d.endpoint_id = e.id AND d.day > (current_date - 7)::text), 0) >= ${LOOKUPS_C2_THRESHOLD}`;
  return sql`e.status = 'active' AND ${notPathTemplateSql()} AND (${attributedWithinWindowSql(daily)} OR ${lookups})`;
}

/**
 * L0 候補の並び（x402_endpoints e + LATERAL lp: last_probed_at / probe_count / last_verdict）。
 *
 * c1（2026-09-02 是正 B）: 「プローブ 1 回で最新が fail」→ 未測定 → 最終プローブが古い順。
 * 本番実測（9/2 19:05 JST）: 最新が fail の 9,769 件のうち 9,713 件はプローブが 1 回だけで、
 * 公開判定（2 回連続 fail・publishedVerdict）が出せなかった。日次枠（3,000）は変えず、
 * 2 回目を先に測って判定を確定させる。同じ組の中は古い順。
 * c2 / all: 従来どおり古い順（未測定が先）。
 */
export function l0OrderBy(tier: "c1" | "c2" | "all"): SQL {
  const oldestFirst = sql`lp.last_probed_at ASC NULLS FIRST, e.first_seen_at ASC`;
  if (tier !== "c1") return oldestFirst;
  return sql`CASE WHEN lp.probe_count = 1 AND lp.last_verdict = 'fail' THEN 0 WHEN lp.last_probed_at IS NULL THEN 1 ELSE 2 END, ${oldestFirst}`;
}

/**
 * L1 候補は C2 のみ（決済帰属あり ∨ 問い合わせ多）。宣言ありは C3 として L1 成功後に
 * L2 を必ず行う（l1-runner が l2Schema を判定する）。
 */
export function l1TierWhere(daily = true): SQL {
  return l0TierWhere("c2", daily);
}

// ------------------------------------------------------------
// ERC-8004 Validation Registry に書く階層（2026-09-02 監査 P1-6）。
// 計画書 2026-09-02-spec-1-2.md: env `REGISTRY_WRITE_TIERS=C2,C3`（既定）。
// endpoint の階層がこの集合に入るときだけ書く。
// ------------------------------------------------------------
export const DEFAULT_REGISTRY_WRITE_TIERS: readonly CoverageTier[] = ["C2", "C3"];

const TIER_NAMES = new Set<string>(["C0", "C1", "C2", "C3", "C4"]);

/** 未設定・空白は既定。知らない語は捨てる（知らない語だけなら空集合＝何も書かない）。 */
export function parseRegistryWriteTiers(raw: string | undefined): Set<CoverageTier> {
  if (!raw || raw.trim() === "") return new Set(DEFAULT_REGISTRY_WRITE_TIERS);
  const out = new Set<CoverageTier>();
  for (const token of raw.split(",")) {
    const t = token.trim().toUpperCase();
    if (TIER_NAMES.has(t)) out.add(t as CoverageTier);
  }
  return out;
}

type TierSignalRow = {
  id: string;
  resource_url: string;
  listed_30d: boolean;
  settled_30d: boolean;
  attributed: number | string;
  lookups7d: number | string;
  has_declaration: boolean;
  reverify_requested: boolean;
};

/**
 * endpoint 群の階層を SQL で写す（tierOf と同じ表。l0TierWhere の c1/c2 条件と同じ式）。
 * 未知の id は結果に入らない（呼び手は C0 に倒す）。
 */
export async function loadCoverageTiers(endpointIds: readonly string[]): Promise<Map<string, CoverageTier>> {
  const out = new Map<string, CoverageTier>();
  if (endpointIds.length === 0) return out;
  const db = getDb();
  if (!db) return out;
  // attributed は件数のまま返す（tierOf は > 0 しか見ないが、意味を変えない）。
  // 集約は 1 行が n 件を表すので、生行の count(*) に sum(n) を足す。
  const attributedCount = (daily: boolean) => {
    const raw = sql`(SELECT count(*)::int FROM settlements s WHERE s.endpoint_id = e.id
               ${ATTRIBUTED_RAW} AND ${SETTLEMENT_DAY} > ${UTC_TODAY} - ${SETTLEMENT_WINDOW_DAYS}::int)`;
    if (!daily) return raw;
    return sql`(${raw} + coalesce((SELECT sum(sd.n)::int FROM settlement_daily sd WHERE sd.endpoint_id = e.id
               ${ATTRIBUTED_DAILY} AND sd.day > ${UTC_TODAY} - ${SETTLEMENT_WINDOW_DAYS}::int), 0))`;
  };
  const q = (daily: boolean) => sql`
    SELECT e.id::text AS id,
           e.resource_url,
           (e.last_seen_at > now() - interval '30 days') AS listed_30d,
           ${settledWithinWindowSql(daily)} AS settled_30d,
           ${attributedCount(daily)} AS attributed,
           coalesce((SELECT sum(n)::int FROM decision_lookups d
               WHERE d.endpoint_id = e.id AND d.day > (current_date - 7)::text), 0) AS lookups7d,
           (e.declared_schema IS NOT NULL) AS has_declaration,
           EXISTS (SELECT 1 FROM disputes d WHERE d.endpoint_id = e.id AND d.status = 'open') AS reverify_requested
    FROM x402_endpoints e
    WHERE e.id = ANY(${sql`ARRAY[${sql.join(endpointIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]`})
  `;
  const raw = await withDailyFallback(
    async () => await db.execute(q(true)),
    async () => await db.execute(q(false)),
  );
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as TierSignalRow[];
  for (const r of rows) {
    out.set(
      r.id,
      tierOf({
        listedWithin30d: r.listed_30d === true,
        settledWithin30d: r.settled_30d === true,
        attributedSettlements: Number(r.attributed ?? 0),
        lookups7d: Number(r.lookups7d ?? 0),
        hasDeclaration: r.has_declaration === true,
        reverifyRequested: r.reverify_requested === true,
        pathTemplate: isPathTemplate(String(r.resource_url ?? "")),
      }),
    );
  }
  return out;
}

/** 1 件版。未知・DB なしは C0（書かない側に倒す）。 */
export async function loadCoverageTier(endpointId: string): Promise<CoverageTier> {
  return (await loadCoverageTiers([endpointId])).get(endpointId) ?? "C0";
}
