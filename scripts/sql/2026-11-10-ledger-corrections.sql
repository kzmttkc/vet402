-- 2026-11-10: 台帳の訂正（公平審査 3.8 の 6c）。self と third_party の提案を追記だけで残す。
--
-- 表: ledger_corrections（src/lib/db/schema.ts の ledgerCorrections と同じ列）。
-- 追記だけ: UPDATE と DELETE はトリガで拒む。元の行を消さない・書き換えない。
-- 追加だけ（CREATE … IF NOT EXISTS / CREATE OR REPLACE）。既存の表は触らない。何度流しても同じ。
-- 旧コードのまま当てても安全: 旧コードはこの表を読まず書かない。
-- 当てるまでの間、/api/v1/observatory/ledger-corrections は 503 ledger_corrections_unavailable を返す（閉じた側に倒れる）。
-- 適用: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-10-ledger-corrections.sql

CREATE TABLE IF NOT EXISTS ledger_corrections (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('self', 'third_party')),
  cited_day text NOT NULL,
  note text NOT NULL,
  signer_address text,
  signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'self' AND signer_address IS NULL AND signature IS NULL)
    OR (kind = 'third_party' AND signer_address IS NOT NULL AND signature IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ledger_corrections_created_idx ON ledger_corrections (created_at);

CREATE OR REPLACE FUNCTION ledger_corrections_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_corrections is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_corrections_no_update_delete ON ledger_corrections;
CREATE TRIGGER ledger_corrections_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION ledger_corrections_append_only();
