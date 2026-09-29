// ============================================================
// §10 訂正ログと異議のレート制限。
//
//   recordCorrection        公開判定が変わったとき before/after を単文 INSERT で残す
//   isDisputeRateLimited    同一 endpoint への連続異議を 7 日 3 件で止める（純関数）
//   listCorrections         公開用の読み出し
//
// 自社に不利な数字を隠すことは仕様違反（§10）。訂正は消さない。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";

/** path_template: 2026-09-02 監査 A1——テンプレート URL を叩いて出した公開 fail を unverified へ戻す。 */
export type CorrectionReason = "dispute_remeasure" | "settlement_backfill" | "reverify" | "path_template";
export type CorrectionLevel = "l0" | "l1" | "l2" | "listing";

export const DISPUTE_WINDOW_DAYS = 7;
export const DISPUTE_MAX_PER_WINDOW = 3;

/** 純関数: 直近の異議の created_at 列（順不同）から、次の 1 件を止めるべきか。 */
export function isDisputeRateLimited(recentCreatedAt: readonly Date[], now: Date): boolean {
  const cutoff = now.getTime() - DISPUTE_WINDOW_DAYS * 86_400_000;
  const n = recentCreatedAt.filter((d) => d.getTime() >= cutoff).length;
  return n >= DISPUTE_MAX_PER_WINDOW;
}

export async function recordCorrection(input: {
  subjectType: "endpoint" | "purchase";
  subjectId: string;
  level: CorrectionLevel;
  before: unknown;
  after: unknown;
  reason: CorrectionReason;
  disputeId?: string | null;
}): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO correction_log (subject_type, subject_id, level, before, after, reason, dispute_id)
      VALUES (${input.subjectType}, ${input.subjectId}, ${input.level},
              ${JSON.stringify(input.before)}::jsonb, ${JSON.stringify(input.after)}::jsonb,
              ${input.reason}, ${input.disputeId ?? null}::uuid)
      RETURNING id::text AS id
    `),
  );
  return rows[0]?.id ?? null;
}

/** 訂正ログの before / after: JS の値（JSON にして入れる）か、`changed`（更新された行）を参照する jsonb 式。 */
export type CorrectionValue = { json: unknown } | { expr: SQL };

type Executor = { execute: (query: SQL) => Promise<unknown> };

/**
 * 台帳の UPDATE と訂正ログの INSERT を**1 つの文**で書く（2026-09-29 敵対的監査 4 周目）。
 *
 * 以前は UPDATE の後に recordCorrection を別の文で呼び、失敗は `.catch(logAndSwallow…)` で
 * 握りつぶしていた。公開の状態（status / tx_hash / 照合の理由）は変わったのに、「いつ何が
 * 変わったか」の記録だけが欠ける——訂正ログの存在理由（§10: 消さない・隠さない）と逆になる。
 * neon-http は複数文のトランザクションを持たないので、データ変更 CTE で 1 文にまとめる:
 *
 *   WITH changed AS (<UPDATE … RETURNING …, <subject id> AS correction_subject_id>),
 *        logged  AS (INSERT INTO correction_log … SELECT … FROM changed RETURNING 1)
 *   SELECT changed.*, (SELECT count(*) FROM logged) AS correction_logged FROM changed
 *
 * どちらかが落ちれば両方とも書かれず、例外は呼び手へ上がる（fail-loud。照合器は行単位で
 * 捕まえて rowErrors に数え、次回のバッチが同じ行を拾い直す＝再試行）。
 * `update` は `correction_subject_id` を RETURNING に含めること。更新 0 行なら訂正も 0 行。
 */
export async function updateWithCorrection<T extends Record<string, unknown>>(
  db: Executor,
  input: {
    update: SQL;
    subjectType: "endpoint" | "purchase";
    level: CorrectionLevel;
    reason: CorrectionReason;
    before: CorrectionValue;
    after: CorrectionValue;
    disputeId?: string | null;
  },
): Promise<(T & { correction_subject_id: string; correction_logged: number })[]> {
  const value = (v: CorrectionValue): SQL => ("expr" in v ? v.expr : sql`${JSON.stringify(v.json)}::jsonb`);
  const rows = rowsOf<T & { correction_subject_id: string; correction_logged: number }>(
    await db.execute(sql`
      WITH changed AS (${input.update}),
      logged AS (
        INSERT INTO correction_log (subject_type, subject_id, level, before, after, reason, dispute_id)
        SELECT ${input.subjectType}, changed.correction_subject_id::text, ${input.level},
               ${value(input.before)}, ${value(input.after)}, ${input.reason}, ${input.disputeId ?? null}::uuid
        FROM changed
        RETURNING 1
      )
      SELECT changed.*, (SELECT count(*) FROM logged)::int AS correction_logged FROM changed
    `),
  );
  for (const r of rows) {
    if (Number(r.correction_logged) !== rows.length) {
      // 同じ文なので起きないはずだが、起きたら黙らない（計器の故障）。
      throw new Error(`correction_log count mismatch: changed=${rows.length} logged=${r.correction_logged}`);
    }
  }
  return rows;
}

/**
 * settlement_backfill の行が台帳のどの経路を通ったか（2026-09-29 監査 5 周目・データ記者の立場）。
 *
 * 保存されている before / after から**読み出し時に**決める派生の語で、台帳・訂正ログの値は変えない。
 * 監査で、売り手が PAYMENT-RESPONSE で名指した tx を照合へ回した行（recover-late の promoteNamedTx・
 * delivered_no_receipt → settle_claimed で tx は売り手の原文のまま）が、vet402 の索引が貼った行と同じ
 * 形に見え、export の settlement_source=seller_claim と食い違って見えた。どちらの経路かは before.txHash と
 * after.txHash が同じか（売り手の原文）で分かるので、それを語で出す。
 *
 *   verified_settled          settle_claimed → settled（チェーン上で送金を再読した）
 *   claim_refuted             → settle_claim_refuted（売り手の申告した送金が見つからなかった・売り手に不利な行）
 *   seller_named_tx_promoted  delivered_no_receipt / settle_failed で、売り手が名指した tx を持っていた行を、売り手の
 *                             申告として照合へ回した（tx は売り手の原文・export の settlement_source は seller_claim）
 *   vet402_index_link         売り手は使える tx を名指さず、vet402 の決済索引が見つけた tx を貼った
 *                             （export の settlement_source は、その tx のまま settled になれば vet402_index）
 *   late_link_withdrawn       照合器が vet402 の貼った tx を購入に結び付けられず、貼る前の status へ戻した
 *   seller_named_tx_declined  売り手が success:false のまま名指した tx が照合で合わず、元の status へ戻した
 *                             （売り手は決済していないと申告していたので、売り手の否定にはしない）
 *   other                     上のどれにも当たらない形（語を増やすまでの受け皿）
 * settlement_backfill 以外の行は null。
 */
export const SETTLEMENT_PATHS = [
  "verified_settled",
  "claim_refuted",
  "seller_named_tx_promoted",
  "vet402_index_link",
  "late_link_withdrawn",
  "seller_named_tx_declined",
  "other",
] as const;
export type SettlementPath = (typeof SETTLEMENT_PATHS)[number];

function asObject(v: unknown): Record<string, unknown> {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return {};
    }
  }
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

const txOf = (o: Record<string, unknown>): string | null =>
  typeof o.txHash === "string" && o.txHash !== "" ? o.txHash.toLowerCase() : null;

/** 純関数。保存済みの before / after から経路の語を決める（値は変えない）。 */
export function settlementPathOf(row: { reason: string; before: unknown; after: unknown }): SettlementPath | null {
  if (row.reason !== "settlement_backfill") return null;
  const before = asObject(row.before);
  const after = asObject(row.after);
  if (after.lateLinkWithdrawn !== undefined) return "late_link_withdrawn";
  if (after.sellerDeclaredUnsettled !== undefined) return "seller_named_tx_declined";
  if (after.status === "settled") return "verified_settled";
  if (after.status === "settle_claim_refuted") return "claim_refuted";
  if (after.status === "settle_claimed") {
    const b = txOf(before);
    const a = txOf(after);
    if ((before.status === "delivered_no_receipt" || before.status === "settle_failed") && b !== null && b === a) {
      return "seller_named_tx_promoted";
    }
    if (a !== null && a !== b) return "vet402_index_link";
  }
  return "other";
}

export type CorrectionRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  level: string;
  before: unknown;
  after: unknown;
  reason: string;
  dispute_id: string | null;
  created_at: string;
  /** settlement_backfill の行の経路（settlementPathOf・読み出し時の派生）。他の reason は null。 */
  settlement_path: SettlementPath | null;
};

/** 1 頁の上限（公開 API と /corrections の表の読み込み）。 */
export const CORRECTIONS_PAGE_MAX = 500;

export const CORRECTION_REASONS: readonly CorrectionReason[] = [
  "dispute_remeasure",
  "settlement_backfill",
  "reverify",
  "path_template",
];

/**
 * 頁送りのカーソル（2026-09-29 監査 5 周目: 最新 500 件より前へ遡れなかった）。
 * 並びは (created_at DESC, id DESC) で、カーソルは直前の頁の最後の行の組。created_at はマイクロ秒まで
 * 文字列で持つ（Date に通すとミリ秒に丸まり、同じミリ秒の行を飛ばす）。外には base64url の不透明な文字列で渡す。
 */
export type CorrectionCursor = { createdAt: string; id: string };

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres の timestamptz の text 表現（例 2026-09-29 02:15:32.820289+00）と ISO 8601 の両方。 */
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export function encodeCorrectionCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}|${row.id}`, "utf8").toString("base64url");
}

/** 形の合わないカーソルは null（呼び手が 400 にする）。 */
export function decodeCorrectionCursor(raw: string): CorrectionCursor | null {
  if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const bar = text.lastIndexOf("|");
  if (bar <= 0) return null;
  const createdAt = text.slice(0, bar);
  const id = text.slice(bar + 1);
  if (!TIMESTAMP_SHAPE.test(createdAt) || !UUID_SHAPE.test(id) || Number.isNaN(Date.parse(createdAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")))) {
    return null;
  }
  return { createdAt, id };
}

/**
 * 訂正ログの**全件**を reason で数える（2026-09-19 独立レビュー W7）。
 *
 * /corrections の見出しは `listCorrections({ limit: 500 })` の配列長を件数として出していたが、
 * 本番ではその上限に張り付いていて、見出しの「500」は件数ではなく**上限**だった
 * （2026-09-04 監査 P1-11 と同種の事故——同じ頁で見出しと本文が別の数を名乗る）。
 * 見出しはここで数え、表は読み込んだ分だけ描く。
 */
export async function countCorrectionsByReason(): Promise<{ settlementBackfill: number; verdictChanges: number }> {
  const db = getDb();
  if (!db) return { settlementBackfill: 0, verdictChanges: 0 };
  const rows = rowsOf<{ settlement_backfill: number; verdict_changes: number }>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE reason = 'settlement_backfill')::int AS settlement_backfill,
             count(*) FILTER (WHERE reason <> 'settlement_backfill')::int AS verdict_changes
      FROM correction_log
    `),
  );
  return {
    settlementBackfill: Number(rows[0]?.settlement_backfill ?? 0),
    verdictChanges: Number(rows[0]?.verdict_changes ?? 0),
  };
}

export type CorrectionFilter = {
  endpointId?: string;
  reason?: CorrectionReason;
  limit?: number;
  /** この組より古い行だけ（頁送り）。 */
  before?: CorrectionCursor;
};

function correctionWhere(filter: CorrectionFilter, withCursor: boolean): SQL {
  const conds: SQL[] = [];
  if (filter.endpointId) conds.push(sql`subject_type = 'endpoint' AND subject_id = ${filter.endpointId}`);
  if (filter.reason) conds.push(sql`reason = ${filter.reason}`);
  if (withCursor && filter.before) {
    conds.push(sql`(created_at, id) < (${filter.before.createdAt}::timestamptz, ${filter.before.id}::uuid)`);
  }
  return conds.length === 0 ? sql`` : sql`WHERE ${sql.join(conds, sql` AND `)}`;
}

export async function listCorrections(filter: CorrectionFilter = {}): Promise<CorrectionRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100) || 1, 1), CORRECTIONS_PAGE_MAX);
  // 2026-09-29 監査 5 周目: 同じ created_at の行（1 文で書いた訂正は同じ時刻を持つ）を頁の境目で落とさないよう、
  // id を第 2 キーにして全順序にする。カーソルはこの組で比べる。
  const rows = rowsOf<Omit<CorrectionRow, "settlement_path">>(
    await db.execute(sql`
      SELECT id::text AS id, subject_type, subject_id, level, before, after, reason,
             dispute_id::text AS dispute_id, created_at::text AS created_at
      FROM correction_log
      ${correctionWhere(filter, true)}
      ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `),
  );
  return rows.map((r) => ({ ...r, settlement_path: settlementPathOf(r) }));
}

/** フィルタ（endpoint・reason）に合う行の総数。カーソルは数えない（頁の位置によらず同じ値）。 */
export async function countCorrections(filter: Pick<CorrectionFilter, "endpointId" | "reason"> = {}): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM correction_log ${correctionWhere(filter, false)}`),
  );
  return Number(rows[0]?.n ?? 0);
}

/** endpoint の直近 7 日の異議 created_at（レート制限用）。 */
export async function recentDisputeTimes(endpointId: string): Promise<Date[]> {
  const db = getDb();
  if (!db) return [];
  return rowsOf<{ created_at: string }>(
    await db.execute(sql`
      SELECT created_at::text AS created_at FROM disputes
      WHERE endpoint_id = ${endpointId}::uuid AND created_at > now() - make_interval(days => ${DISPUTE_WINDOW_DAYS})
    `),
  ).map((r) => new Date(r.created_at));
}
