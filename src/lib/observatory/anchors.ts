// ============================================================
// 台帳ハッシュチェーン（TEE設計 docs/tee-zk-integrity.md Stage 0）。
//
// 何を固定するか: その UTC 日の全 L1 行（全 status・主キー昇順）を安定した
// 射影で正規化JSONにし、前日の root を先頭に連結して sha256 を取る。
// 過去のどの行を書き換えても、その日以降の全 root が検算で崩れる——
// 「この記録がこの時点で存在した」を第三者が末尾から検証できる。
//
// 誰でも再計算できることが価値なので、射影・順序・連結規則はこのファイルが
// 正典（変更は root の断絶を意味する。変更するなら新チェーンとして明示）。
//
// オンチェーンへの刻印（anchored_tx）は ANCHOR_WRITES_ENABLED（既定OFF・
// ガス代）。刻印済みの日の root は**いかなる理由でも上書きしない**——
// 食い違いは conflict_frozen として返し、呼び手（cron）が ALERT に出す。
//
// 2026-11-10 公平審査（3.8 の 6c）: 日次ジョブが止まった日は、後から埋めない。
// 後で計算した root を「その日のヘッド」として出すと、その日に封印していない
// ものを封印済みに見せる（probe402 の 11/5〜7 の穴と同じ形）。止まった日は
// ledger_anchors に行を作らず、次に封印する日はその前に存在する最新の root に
// 繋ぐ。穴は chainContinuity の gaps と、anchors の GET の missingHeadDays に
// 「その日はヘッドが無い」として出る。後ろに日が繋がった root は書き換えない。
// ============================================================
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { utcDayStartOf } from "@/lib/db/utc-day";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isAnchorWritesEnabled(): boolean {
  return process.env.ANCHOR_WRITES_ENABLED === "true";
}

type Db = NonNullable<ReturnType<typeof getDb>>;

// 日の境界は UTC で明示する（2026-09-29 監査 6 周目）。`${day}::date` は timestamptz と比べる瞬間に
// 接続の TimeZone で解釈される——本番（GMT）では UTC 日と同じだが、接続設定が変わると root が別の行の集合を
// 指す。utcDayStartOf は TimeZone に依らず同じ瞬間（tests/audit-r6-consistency.pg.test.ts）。
/** その日の正規化ペイロード（決定的・主キー昇順）。export はテスト用（TimeZone を変えた接続で同じ行を返すか）。 */
export async function canonicalDayPayload(db: Pick<Db, "execute">, day: string): Promise<{ payload: string; count: number }> {
  const raw = await db.execute(sql`
    SELECT pu.id::text AS id, pu.endpoint_id::text AS endpoint_id,
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS attempted_at,
           pu.status, pu.network, pu.asset, pu.pay_to, pu.amount_units, pu.spent_units,
           pu.payer, pu.tx_hash, pu.http_status_paid, pu.latency_ms, pu.l2_schema
    FROM x402_l1_purchases pu
    WHERE pu.attempted_at >= ${utcDayStartOf(day)} AND pu.attempted_at < ${utcDayStartOf(day)} + interval '1 day'
    ORDER BY pu.id ASC
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  return { payload: JSON.stringify({ v: 1, day, rows }), count: rows.length };
}

export type AnchorResult = {
  day: string;
  rootHash: string;
  /** conflict_frozen のとき、今の行から計算し直した root（保存値は rootHash のまま）。 */
  recomputedRoot?: string;
  entryCount: number;
  /** created | unchanged | updated | conflict_frozen */
  status: "created" | "unchanged" | "updated" | "conflict_frozen";
};

const DAY_MS = 86_400_000;

/** from..to（閉区間）のうち have に無い日。 */
export function missingDaysBetween(from: string, to: string, have: readonly string[]): string[] {
  const set = new Set(have);
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!set.has(d)) out.push(d);
  }
  return out;
}

/**
 * 鎖の検証は「連結」と「連続」の両方。連結だけ見ると、欠けた日を飛ばして
 * 繋いだ鎖が intact に見える（2026-09-02 監査で実際にそうなっていた）。
 */
export function chainContinuity(
  newestFirst: readonly { day: string; rootHash: string; prevRoot: string | null }[],
): { linked: boolean; contiguous: boolean; gaps: string[]; intact: boolean } {
  let linked = true;
  const gaps: string[] = [];
  for (let i = 0; i + 1 < newestFirst.length; i++) {
    const newer = newestFirst[i];
    const older = newestFirst[i + 1];
    if (newer.prevRoot !== older.rootHash) linked = false;
    gaps.push(...missingDaysBetween(older.day, newer.day, [older.day, newer.day]));
  }
  return { linked, contiguous: gaps.length === 0, gaps, intact: linked && gaps.length === 0 };
}

/**
 * day より前に存在する最新の root（無ければ genesis = null）。穴を跨いでも繋ぐ。
 * 穴は埋めず、chainContinuity が gaps として名指しする（2026-11-10）。
 */
async function latestRootBefore(db: Db, day: string): Promise<string | null> {
  const raw = await db.execute(sql`
    SELECT root_hash FROM ledger_anchors WHERE day < ${day} ORDER BY day DESC LIMIT 1
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { root_hash: string }[];
  return rows.length > 0 ? rows[0].root_hash : null;
}

/** day より後に封印済みの日があるか。あれば day の root は後ろの鎖に入っている。 */
async function hasLaterAnchor(db: Db, day: string): Promise<boolean> {
  const raw = await db.execute(sql`SELECT 1 FROM ledger_anchors WHERE day > ${day} LIMIT 1`);
  return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as unknown[]).length > 0;
}

/**
 * `to` の日だけを封印する。欠けた日は埋めない（2026-11-10 公平審査 3.8 の 6c）。
 * 戻り値は 1 件（`to` の結果）。呼び手の配列の形は 2026-09-02 からのものを保つ。
 */
export async function anchorThrough(to: string): Promise<AnchorResult[]> {
  if (!DAY_RE.test(to)) throw new Error(`anchorThrough: not a YYYY-MM-DD day: ${to}`);
  return [await anchorDay(to)];
}

export async function anchorDay(day: string): Promise<AnchorResult> {
  if (!DAY_RE.test(day)) throw new Error(`anchorDay: not a YYYY-MM-DD day: ${day}`);
  const db = getDb();
  if (!db) throw new Error("anchorDay: DATABASE_URL is not configured");

  const { payload, count } = await canonicalDayPayload(db, day);
  // 2026-11-10: 前の root は「day より前に存在する最新の日」。穴は埋めない。
  // 2026-09-02 の「穴が 5 日間検出されなかった」は、連結と連続を分けて見る
  // chainContinuity と、GET の missingHeadDays・headFreshness で公開して防ぐ。
  const prevRoot = await latestRootBefore(db, day);
  const rootHash = createHash("sha256")
    .update(prevRoot ?? "genesis")
    .update("\n")
    .update(payload)
    .digest("hex");

  const existingRaw = await db.execute(sql`
    SELECT root_hash, anchored_tx FROM ledger_anchors WHERE day = ${day}
  `);
  const existing = (Array.isArray(existingRaw)
    ? existingRaw
    : (existingRaw as { rows?: unknown[] }).rows ?? []) as {
    root_hash: string;
    anchored_tx: string | null;
  }[];

  const laterExists = await hasLaterAnchor(db, day);
  if (existing.length === 0) {
    // 後ろに封印済みの日がある過去の日を、後から封印しない（穴埋めの禁止）。
    if (laterExists) {
      throw new Error(`anchorDay: ${day} より後の日が封印済み——過去の穴は埋めない（no_head_for_day として公開する）`);
    }
    await db.execute(sql`
      INSERT INTO ledger_anchors (day, root_hash, prev_root, entry_count)
      VALUES (${day}, ${rootHash}, ${prevRoot}, ${count})
      ON CONFLICT (day) DO NOTHING
    `);
    return { day, rootHash, entryCount: count, status: "created" };
  }
  if (existing[0].root_hash === rootHash) {
    return { day, rootHash, entryCount: count, status: "unchanged" };
  }
  if (existing[0].anchored_tx || laterExists) {
    // 刻印済み、または後ろの日がこの root に繋がっている。現データとの食い違いは
    // 整合性イベントであり、書き換えない（書き換えると後ろの鎖が切れる）。
    return {
      day,
      rootHash: existing[0].root_hash,
      recomputedRoot: rootHash,
      entryCount: count,
      status: "conflict_frozen",
    };
  }
  // 鎖の先頭（後ろに日が無い）で未刻印なら、同日中の遅延到着行を取り込んで更新する。
  await db.execute(sql`
    UPDATE ledger_anchors SET root_hash = ${rootHash}, prev_root = ${prevRoot}, entry_count = ${count}
    WHERE day = ${day}
  `);
  return { day, rootHash, entryCount: count, status: "updated" };
}

export type AnchorRow = {
  day: string;
  rootHash: string;
  prevRoot: string | null;
  entryCount: number;
  anchoredTx: string | null;
};

export async function getAnchors(days: number): Promise<AnchorRow[]> {
  const span = Math.min(Math.max(Math.trunc(days) || 0, 1), 366);
  const db = getDb();
  if (!db) return [];
  const raw = await db.execute(sql`
    SELECT day, root_hash, prev_root, entry_count, anchored_tx
    FROM ledger_anchors ORDER BY day DESC LIMIT ${span}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    day: String(r.day),
    rootHash: String(r.root_hash),
    prevRoot: r.prev_root === null ? null : String(r.prev_root),
    entryCount: Number(r.entry_count),
    anchoredTx: r.anchored_tx === null ? null : String(r.anchored_tx),
  }));
}

/**
 * ある日の検証の材料を、別々の場所から読む（2026-11-10 公平審査 3.8 の 6c-1）。
 *   payload   … その日の L1 行から作った正規化バイト列（公開ファイル /observatory/anchors/day と同じ）
 *   head      … ledger_anchors に封印した、その日の root と prev_root（公開ヘッド）
 *   chainRoot … 次に封印した日の prev_root（鎖がこの日の値として持っているもの）。次の日が無ければ null
 * どれか 1 つを他から写すと検証にならないので、関数は 3 つを混ぜずに返す。
 */
export type DayVerificationInputs = {
  day: string;
  payload: string;
  entryCount: number;
  head: { day: string; rootHash: string; prevRoot: string | null } | null;
  chainRoot: string | null;
  chainRootDay: string | null;
};

export async function readDayVerificationInputs(db: Pick<Db, "execute">, day: string): Promise<DayVerificationInputs> {
  if (!DAY_RE.test(day)) throw new Error(`readDayVerificationInputs: not a YYYY-MM-DD day: ${day}`);
  const { payload, count } = await canonicalDayPayload(db, day);
  const headRaw = await db.execute(sql`SELECT day, root_hash, prev_root FROM ledger_anchors WHERE day = ${day}`);
  const headRows = (Array.isArray(headRaw) ? headRaw : (headRaw as { rows?: unknown[] }).rows ?? []) as {
    day: string;
    root_hash: string;
    prev_root: string | null;
  }[];
  const nextRaw = await db.execute(sql`
    SELECT day, prev_root FROM ledger_anchors WHERE day > ${day} ORDER BY day ASC LIMIT 1
  `);
  const nextRows = (Array.isArray(nextRaw) ? nextRaw : (nextRaw as { rows?: unknown[] }).rows ?? []) as {
    day: string;
    prev_root: string | null;
  }[];
  const head = headRows[0]
    ? {
        day: String(headRows[0].day),
        rootHash: String(headRows[0].root_hash),
        prevRoot: headRows[0].prev_root === null ? null : String(headRows[0].prev_root),
      }
    : null;
  const next = nextRows[0];
  return {
    day,
    payload,
    entryCount: count,
    head,
    chainRoot: next && next.prev_root !== null ? String(next.prev_root) : null,
    chainRootDay: next ? String(next.day) : null,
  };
}
