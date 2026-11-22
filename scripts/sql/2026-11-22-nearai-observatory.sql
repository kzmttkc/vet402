-- vet402 2026-11-22 — NEAR AI Cloud TEE attestation observatory (stage 1, keyless).
-- Apply before deploying code that reads these tables:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-22-nearai-observatory.sql

CREATE TABLE IF NOT EXISTS nearai_probe_runs (
  id serial PRIMARY KEY,
  run_uuid text NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  utc_day date NOT NULL,
  pccs_url text NOT NULL,
  nearai_model_count integer NOT NULL,
  gateway_ok boolean NOT NULL,
  gateway_tcb_status text,
  run_status text NOT NULL,
  summary_json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS nearai_model_probes (
  id serial PRIMARY KEY,
  run_id integer NOT NULL REFERENCES nearai_probe_runs(id),
  utc_day date NOT NULL,
  model_id text NOT NULL,
  candidate_count integer NOT NULL,
  tcb_status text NOT NULL,
  advisory_ids_json jsonb NOT NULL,
  gpu_pass boolean NOT NULL,
  public_status text NOT NULL,
  failure_class text,
  row_sha256 text NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  held boolean NOT NULL DEFAULT false,
  probed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS nearai_model_probes_utc_day_idx ON nearai_model_probes (utc_day);
CREATE INDEX IF NOT EXISTS nearai_model_probes_run_id_idx ON nearai_model_probes (run_id);

CREATE TABLE IF NOT EXISTS nearai_day_roots (
  day date PRIMARY KEY,
  root_hash text NOT NULL CHECK (root_hash ~ '^[0-9a-f]{64}$'),
  prev_root text,
  entry_count integer NOT NULL,
  payload_json text NOT NULL,
  sealed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS nearai_held_targets (
  target_key text PRIMARY KEY,
  failure_class text NOT NULL,
  confirmed_at timestamptz NOT NULL
);