-- vet402 2026-09-29 — /decision の問い合わせ数を「呼び手 × endpoint × UTC 日」で 1 回に数える（監査 5 周目・高）。
--
-- 攻撃の形: 鍵なしの判定 API（10 回/分/IP）で同じ出品を 5 回叩くと、decision_lookups.n が 5 になり
-- 「問い合わせ多」（coverage.ts LOOKUPS_C2_THRESHOLD）で L1 の最優先枠に入った。同じ payTo の $1 の出品を
-- 多数載せれば、1 人の売り手が日次 $25 を毎日取れた（上限の側は l1-runner reserveSpend で別に締める）。
--
-- この表に (endpoint_id, day, caller_hash) を ON CONFLICT DO NOTHING で入れ、**入ったときだけ**
-- decision_lookups.n を 1 増やす（decide.ts recordDecisionLookup・単一文）。decision_lookups の形と読み手は変えない。
-- caller_hash は鍵 id か IP（IPv6 は /64）の HMAC-SHA256（鍵は API_KEY_PEPPER から HKDF・材料に日付を含む）。
-- 生の IP・鍵は保存しない。保持は 8 日（src/lib/cron/log-retention.ts が消す）。
--
-- 順序: この CREATE を本番に適用してから、この表へ書くコードをデプロイする。逆順だと、適用までの間の問い合わせは
-- 数えられない（recordDecisionLookup は失敗をログへ出して判定は返す——昇格が止まる側に倒れるだけで、判定・支払いは壊れない）。
--
-- 追加のみ。Safe to re-run. 本番 DB は同一 Neon ホストの **vouch** database（neondb ではない）。
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-09-29-decision-lookup-callers.sql
CREATE TABLE IF NOT EXISTS decision_lookup_callers (
  endpoint_id uuid NOT NULL,
  day         text NOT NULL,
  caller_hash text NOT NULL,
  PRIMARY KEY (endpoint_id, day, caller_hash)
);
CREATE INDEX IF NOT EXISTS decision_lookup_callers_day_idx ON decision_lookup_callers (day);
