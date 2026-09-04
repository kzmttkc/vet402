-- 2026-09-04 監査 B・P2: /api/v1/resources/{id}/decision の Idempotency-Key（§9.3）。
--
-- 従来はプロセス内の Map に「見た」ことだけを覚え、再送はレート単位を返金しつつ
-- **毎回再計算**していた。Vercel は複数インスタンスなので、別インスタンスに落ちた
-- 再送は初回扱いになり、同じキーで違う応答が返り得る。保存した応答をそのまま返す。
--
-- key_hash = sha256(apiKeyId|resource|role|payer|Idempotency-Key)。生のキーは持たない。
-- TTL は 10 分（route の IDEMPOTENCY_TTL_MS と同値）。期限切れ行は purge-logs cron と
-- 書き込み時の同一文 CTE で掃く。ip_rate_limits と同じ「読んでから書かない」単一文 upsert。
CREATE TABLE IF NOT EXISTS decision_idempotency (
  key_hash   text PRIMARY KEY,
  body       jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_idempotency_expires_idx
  ON decision_idempotency (expires_at);
