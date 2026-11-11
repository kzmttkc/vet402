// ============================================================
// 台帳の訂正の保存（2026-11-10 公平審査 3.8 の 6c）。追記だけ。
//
// 本番は Postgres の ledger_corrections（scripts/sql/2026-11-10-ledger-corrections.sql。UPDATE と
// DELETE はトリガで拒む）。この module に行を消す・書き換える関数は無い。
// 以前の版はプロセスのメモリと手元の JSONL だった。Vercel の関数は手元のファイルに書けず、
// 再起動とインスタンスごとに行が消える。それでは「追記したものが残る」にならない。
// DB が無いときは null を返し、HTTP は 503 で閉じる（メモリに置いて受け付けたふりをしない）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { LedgerCorrectionEntry, LedgerCorrectionKind } from "@/lib/observatory/ledger-corrections-public";

export type LedgerCorrectionStore = {
  /** 古い順。 */
  list(): Promise<LedgerCorrectionEntry[]>;
  /** 1 行を足す。既存の行には触らない。 */
  append(entry: LedgerCorrectionEntry): Promise<void>;
};

type Row = {
  id: string;
  kind: string;
  cited_day: string;
  cited_row_id: string | null;
  prior_row_sha256: string | null;
  note: string;
  signer_address: string | null;
  signature: string | null;
  created_at: string | Date;
};

function toEntry(r: Row): LedgerCorrectionEntry {
  const entry: LedgerCorrectionEntry = {
    id: String(r.id),
    kind: r.kind as LedgerCorrectionKind,
    citedDay: String(r.cited_day),
    note: String(r.note),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  };
  if (r.cited_row_id !== null && r.cited_row_id !== undefined) entry.citedRowId = String(r.cited_row_id);
  if (r.prior_row_sha256 !== null && r.prior_row_sha256 !== undefined) entry.priorRowSha256 = String(r.prior_row_sha256);
  if (r.signer_address !== null) entry.signerAddress = String(r.signer_address);
  if (r.signature !== null) entry.signature = String(r.signature);
  return entry;
}

export function dbLedgerCorrectionStore(): LedgerCorrectionStore | null {
  const db = getDb();
  if (!db) return null;
  return {
    async list() {
      const raw = await db.execute(sql`
        SELECT id, kind, cited_day, cited_row_id, prior_row_sha256, note, signer_address, signature, created_at
        FROM ledger_corrections ORDER BY created_at ASC, id ASC LIMIT 5000
      `);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Row[];
      return rows.map(toEntry);
    },
    async append(entry) {
      await db.execute(sql`
        INSERT INTO ledger_corrections
          (id, kind, cited_day, cited_row_id, prior_row_sha256, note, signer_address, signature, created_at)
        VALUES (${entry.id}, ${entry.kind}, ${entry.citedDay}, ${entry.citedRowId ?? null}, ${entry.priorRowSha256 ?? null}, ${entry.note},
                ${entry.signerAddress ?? null}, ${entry.signature ?? null}, ${entry.createdAt}::timestamptz)
      `);
    },
  };
}

/** 試験用の追記だけの保存。append は配列の末尾に足すだけで、既存の要素を置き換えない。 */
export function memoryLedgerCorrectionStore(seed: readonly LedgerCorrectionEntry[] = []): LedgerCorrectionStore & {
  rows: readonly LedgerCorrectionEntry[];
} {
  const rows: LedgerCorrectionEntry[] = [...seed];
  return {
    rows,
    async list() {
      return rows.map((r) => ({ ...r }));
    },
    async append(entry) {
      rows.push({ ...entry });
    },
  };
}

let storeOverride: LedgerCorrectionStore | null = null;

/** HTTP の試験が DB 無しで保存を差し替えるための口。本番のコードは呼ばない。 */
export function setLedgerCorrectionStoreForTests(store: LedgerCorrectionStore | null): void {
  storeOverride = store;
}

export function ledgerCorrectionStore(): LedgerCorrectionStore | null {
  return storeOverride ?? dbLedgerCorrectionStore();
}
