// ============================================================
// vet402 Observatory — 実行時の支出停止スイッチ（2026-09-05 監査 P0）。
//
// 事故の形: 不正な支出を見つけても、L1 実購入を止める手段が Vercel env
// `OBSERVATORY_L1_ENABLED` の変更＋再デプロイしかなかった。起動点は 4 つ
// （Vercel cron /api/cron/l1-purchase・管理リポ launchd の vet402_l1_extra.py
// 3 本・vet402_l1_canary.py の補填・/api/v1/demo/verify level=l1）あり、
// 再デプロイが終わるまでどれもが署名できる。env は「設定」であって
// 「操作卓」ではない。
//
// だから停止は **DB の 1 行**（runtime_flags.l1_spending_halt）に置く。
// UPDATE 1 文で即時に効き、次の署名から止まる。デプロイを待たない。
//
// job_leases の acquireLease を流用しない: あれは例外時に「通す」設計
// （リースが取れない＝走らせない、ではなく、DB が死んでいても cron を
// 止めないための可用性優先）。停止スイッチは逆の倒れ方をしなければならない。
//
// fail-closed の定義（decideHalt が唯一の判定・テストは tests/l1-kill-switch.test.ts）:
//   表が無い / 行が無い   → halted=false。未導入は「現状維持」であって停止指示ではない。
//                            逆にすると、この表を作る前のデプロイが全部止まる。
//   DB 到達不能 / 例外    → halted=true。**読めないなら止める側へ倒す。**
//                            金を動かす関門で「読めなかったので通した」は無い。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";

/** runtime_flags.name。DDL（scripts/sql/2026-09-05-runtime-flags.sql）・admin ルート・runbook が同じ名を参照する。 */
export const SPENDING_HALT_FLAG = "l1_spending_halt";

/** decideHalt に渡す「DB を読んだ結果」。読み取りと判定を分けて、判定を純関数のまま試験する。 */
export type HaltProbe =
  | { kind: "row"; enabled: boolean; reason: string | null }
  /** 表はあるが行が無い（一度も止めていない）。 */
  | { kind: "absent" }
  /** runtime_flags 自体がまだ無い（DDL 未適用）。 */
  | { kind: "schema_missing" }
  /** DB へ届かない・クエリが例外を投げた。 */
  | { kind: "unreachable"; detail: string };

export type HaltVerdict = {
  halted: boolean;
  /** 応答・ログ・台帳の raw_response_meta に載る一行。必ず非空。 */
  reason: string;
  /**
   * 何を読んでこう決めたか。資金の扱いは source で変わらない（halted なら
   * どの source でも署名しない）が、公開デモ口は「運用者が実際に止めた」
   * （row）だけを 503 spending_halted として見せ、それ以外は従来どおり
   * ランナー側の fail-closed に委ねる。
   */
  source: HaltProbe["kind"];
};

const REASON_MAX = 300;

function clip(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

/** 純関数。ここだけが「止めるか」を決める。 */
export function decideHalt(probe: HaltProbe): HaltVerdict {
  switch (probe.kind) {
    case "row":
      if (!probe.enabled) return { halted: false, reason: "flag_off", source: "row" };
      return {
        halted: true,
        reason: clip(`halted_by_operator: ${probe.reason?.trim() || "(no reason recorded)"}`),
        source: "row",
      };
    case "absent":
      return { halted: false, reason: "no_flag_row", source: "absent" };
    case "schema_missing":
      return { halted: false, reason: "flag_table_absent", source: "schema_missing" };
    case "unreachable":
      return {
        halted: true,
        reason: clip(`halt_flag_unreadable: ${probe.detail}`),
        source: "unreachable",
      };
  }
}

type Db = NonNullable<ReturnType<typeof getDb>>;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<
    string,
    unknown
  >[];
}

/** DB を1回読んで probe を作る。例外はここで捕まえ、decideHalt へ渡す形に落とす。 */
async function probeSpendingHalt(dbOverride?: Db | null): Promise<HaltProbe> {
  const db = dbOverride ?? getDb();
  // DATABASE_URL が無い＝台帳も読めない。L1 は台帳なしでは走れないので、
  // ここは「未導入」ではなく「読めない」に分類する（止める側）。
  if (!db) return { kind: "unreachable", detail: "DATABASE_URL is not configured" };
  try {
    const raw = await db.execute(sql`
      SELECT enabled, reason FROM runtime_flags WHERE name = ${SPENDING_HALT_FLAG}
    `);
    const row = rowsOf(raw)[0];
    if (!row) return { kind: "absent" };
    return {
      kind: "row",
      enabled: row.enabled === true || row.enabled === "t" || row.enabled === "true",
      reason: typeof row.reason === "string" ? row.reason : null,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return { kind: "schema_missing" };
    return { kind: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 「いま支出を止めているか」。署名の直前で呼ぶ（l1-runner.purchaseOne）。
 * 1 行の SELECT なので、バッチの各購入で呼んでも実測で無視できる（neon-http の
 * 1 往復・数十 ms）。止まる速さのほうが桁で重要。
 */
export async function isSpendingHalted(dbOverride?: Db | null): Promise<HaltVerdict> {
  return decideHalt(await probeSpendingHalt(dbOverride));
}

export type HaltFlagState = {
  name: string;
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** 行がまだ無い / 表がまだ無いときの注記（admin GET が返す）。 */
  note?: string;
};

/** admin GET 用。判定ではなく「いま台帳に何が書いてあるか」をそのまま返す。 */
export async function readSpendingHaltState(dbOverride?: Db | null): Promise<HaltFlagState> {
  const db = dbOverride ?? getDb();
  const empty: HaltFlagState = {
    name: SPENDING_HALT_FLAG,
    enabled: false,
    reason: null,
    updatedAt: null,
    updatedBy: null,
  };
  if (!db) return { ...empty, note: "database_not_configured" };
  try {
    const raw = await db.execute(sql`
      SELECT enabled, reason, updated_at::text AS updated_at, updated_by
      FROM runtime_flags WHERE name = ${SPENDING_HALT_FLAG}
    `);
    const row = rowsOf(raw)[0];
    if (!row) return { ...empty, note: "no_flag_row" };
    return {
      name: SPENDING_HALT_FLAG,
      enabled: row.enabled === true || row.enabled === "t" || row.enabled === "true",
      reason: typeof row.reason === "string" ? row.reason : null,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return { ...empty, note: "flag_table_absent" };
    throw error;
  }
}

/**
 * 停止/再開を 1 文で書く（読んでから書かない——TOCTOU を作らない）。
 * 履歴は行の updated_at / updated_by / reason に残る。誰がいつ何のために
 * 止めた・戻したかを、行そのものが答えられる状態に保つ。
 */
export async function setSpendingHalt(input: {
  enabled: boolean;
  reason: string;
  updatedBy: string;
  db?: Db | null;
}): Promise<HaltFlagState> {
  const db = input.db ?? getDb();
  if (!db) throw new Error("spending-halt: DATABASE_URL is not configured");
  const raw = await db.execute(sql`
    INSERT INTO runtime_flags (name, enabled, reason, updated_at, updated_by)
    VALUES (${SPENDING_HALT_FLAG}, ${input.enabled}, ${input.reason}, now(), ${input.updatedBy})
    ON CONFLICT (name) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          reason = EXCLUDED.reason,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
    RETURNING enabled, reason, updated_at::text AS updated_at, updated_by
  `);
  const row = rowsOf(raw)[0];
  if (!row) throw new Error("spending-halt: upsert returned no row");
  return {
    name: SPENDING_HALT_FLAG,
    enabled: row.enabled === true || row.enabled === "t" || row.enabled === "true",
    reason: typeof row.reason === "string" ? row.reason : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
  };
}
