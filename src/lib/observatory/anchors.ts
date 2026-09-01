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
// ============================================================
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isAnchorWritesEnabled(): boolean {
  return process.env.ANCHOR_WRITES_ENABLED === "true";
}

type Db = NonNullable<ReturnType<typeof getDb>>;

/** その日の正規化ペイロード（決定的・主キー昇順）。 */
async function canonicalDayPayload(db: Db, day: string): Promise<{ payload: string; count: number }> {
  const raw = await db.execute(sql`
    SELECT pu.id::text AS id, pu.endpoint_id::text AS endpoint_id,
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS attempted_at,
           pu.status, pu.network, pu.asset, pu.pay_to, pu.amount_units, pu.spent_units,
           pu.payer, pu.tx_hash, pu.http_status_paid, pu.latency_ms, pu.l2_schema
    FROM x402_l1_purchases pu
    WHERE pu.attempted_at >= ${day}::date AND pu.attempted_at < ${day}::date + interval '1 day'
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
  entryCount: number;
  /** created | unchanged | updated | conflict_frozen */
  status: "created" | "unchanged" | "updated" | "conflict_frozen";
};

/**
 * 1日ぶんの root を計算して upsert。冪等。
 * 前日 root は DB の連鎖から取る（無ければ genesis = 空文字連結）。
 */
const DAY_MS = 86_400_000;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

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
 * day-1 の root。day-1 が無く、かつそれより前にも 1 行も無ければ genesis
 * （found=true, root=null）。day-1 だけが無い（穴）なら found=false。
 */
async function prevDayRoot(db: Db, day: string): Promise<{ found: boolean; root: string | null }> {
  const prev = shiftDay(day, -1);
  const raw = await db.execute(sql`SELECT root_hash FROM ledger_anchors WHERE day = ${prev}`);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { root_hash: string }[];
  if (rows.length > 0) return { found: true, root: rows[0].root_hash };
  const before = await db.execute(sql`SELECT 1 FROM ledger_anchors WHERE day < ${day} LIMIT 1`);
  const hasEarlier = ((Array.isArray(before) ? before : (before as { rows?: unknown[] }).rows ?? []) as unknown[]).length > 0;
  return { found: !hasEarlier, root: null };
}

/**
 * 最古の固定日から `to` までの欠けた日を古い順に埋め、最後に `to` を固定する。
 * 日次ペイロードは DB から決定的に再計算できるので、後から過去日を固定しても
 * 鎖の意味は変わらない（刻印済みの日は anchorDay が conflict_frozen で守る）。
 */
export async function anchorThrough(to: string, maxBackfillDays = 30): Promise<AnchorResult[]> {
  if (!DAY_RE.test(to)) throw new Error(`anchorThrough: not a YYYY-MM-DD day: ${to}`);
  const db = getDb();
  if (!db) throw new Error("anchorThrough: DATABASE_URL is not configured");
  const raw = await db.execute(sql`SELECT day FROM ledger_anchors WHERE day <= ${to} ORDER BY day ASC`);
  const have = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { day: string }[]).map((r) =>
    String(r.day),
  );
  const from = have[0] ?? to;
  const days = missingDaysBetween(from, to, have).slice(-maxBackfillDays);
  if (!days.includes(to) && !have.includes(to)) days.push(to);
  const out: AnchorResult[] = [];
  for (const d of days) out.push(await anchorDay(d));
  if (have.includes(to) && !days.includes(to)) out.push(await anchorDay(to)); // 既存の to は再計算（unchanged/updated/conflict）
  return out;
}

export async function anchorDay(day: string): Promise<AnchorResult> {
  if (!DAY_RE.test(day)) throw new Error(`anchorDay: not a YYYY-MM-DD day: ${day}`);
  const db = getDb();
  if (!db) throw new Error("anchorDay: DATABASE_URL is not configured");

  const { payload, count } = await canonicalDayPayload(db, day);
  // 2026-09-02 監査: 以前は `day < ${day}` で「直前に存在する日」を取っていた。
  // cron が 1 回落ちると翌日は穴を飛ばして前々日に連結し、鎖は「繋がっている」
  // のに「連続していない」状態になる（本番で 1 日欠けたまま 5 日間検出されず）。
  // 前日 root は day-1 に限る。無ければ呼び手（anchorThrough）が先に埋める。
  const prev = await prevDayRoot(db, day);
  if (!prev.found) {
    throw new Error(`anchorDay: ${day} の前日が未固定——anchorThrough で古い日から埋める`);
  }
  const prevRoot = prev.root;
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

  if (existing.length === 0) {
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
  if (existing[0].anchored_tx) {
    // 刻印済み root と現データが食い違う＝整合性イベント。書き換えない。
    return { day, rootHash: existing[0].root_hash, entryCount: count, status: "conflict_frozen" };
  }
  // 未刻印なら同日中の遅延到着行を取り込んで更新（連鎖の先頭は常に最新日なので安全）。
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
