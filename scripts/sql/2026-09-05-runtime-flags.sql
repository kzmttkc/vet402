-- 2026-09-05 監査 P0: 実行時の支出停止スイッチ。
--
-- 事故の形: L1 実購入（実資金）を止める手段が Vercel env
-- `OBSERVATORY_L1_ENABLED` の変更＋再デプロイしかなかった。起動点は 4 つ
-- （Vercel cron /api/cron/l1-purchase・管理リポ launchd の vet402_l1_extra.py
-- 3 本・vet402_l1_canary.py の補填・/api/v1/demo/verify level=l1）あり、
-- 再デプロイが終わるまでどれもが署名できる。
--
-- 停止を DB の 1 行に出す。UPDATE 1 文で即時に効き、次の署名から止まる。
-- 判定は src/lib/observatory/kill-switch.ts（fail-closed: 表・行が無ければ
-- 通す＝未導入は現状維持、DB が読めなければ止める）。
-- 切り替えは POST /api/admin/spending-halt（ADMIN_SECRET）。
-- 手順は docs/INCIDENT_RUNBOOK.md。
--
-- 行は入れない。行が無い＝停止していない（未導入と同じ扱い）で正しい。

CREATE TABLE IF NOT EXISTS runtime_flags (
  name       text PRIMARY KEY,
  enabled    boolean NOT NULL,
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
