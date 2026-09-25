-- 2026-09-26: ETHGlobal Tokyo 2026 の審査員ボタン（/tokyo・PLAN_v4.3 §3.7.1）。
--
-- 書き手と読み手: src/app/api/tokyo/_lib/store.ts（1文ずつ）。tokyo_mutations は1行だけ（id = 1・store が
-- 初回に INSERT … ON CONFLICT DO NOTHING で作る）。押した人は記録しない（IP も鍵も入れない）。
-- 表が無い間は /api/tokyo/state が state_unavailable を返し、ボタンは押せない側に倒れる。
-- 既存の表には触らない。drizzle-kit push では流さない。

CREATE TABLE IF NOT EXISTS tokyo_mutations (
  id integer PRIMARY KEY DEFAULT 1,
  current_value text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  mutated_at timestamptz,
  reverting_until timestamptz,
  last_tx text,
  CONSTRAINT tokyo_mutations_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS tokyo_mutation_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  from_value text NOT NULL,
  to_value text NOT NULL,
  tx text
);
