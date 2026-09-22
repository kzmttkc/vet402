#!/usr/bin/env bash
# Lightweight local uptime probe for Vouch (vet402) production.
# Runs via launchd (com.kizuna.vouch-uptime-monitor), logs always, and
# leaves a FAIL marker on failure.
#
# 2026-08-23 監査: FAIL マーカーの読み手は daily-improvement-loop だけだったが、
# そのタスクは無効化されている。**鳴っても誰にも届いていなかった**（実測: 30分ごとに
# 失敗し続けて938行、誰も気づかないまま1ヶ月）。
# fail-loud の正典 state/ALERTS.md へ直接書く。連投を避けるため、状態が
# OK→FAIL に変わった最初の1回と、以後6時間ごとにだけ書く。
set -uo pipefail

cd "$(dirname "$0")/.."
export CRON_SECRET
CRON_SECRET=$(grep -m1 '^CRON_SECRET=' .env.production.local | cut -d= -f2-)

LOG="logs/uptime-cron.log"
FAIL_MARKER="logs/uptime-cron.FAIL"
ALERTS="${VET402_ALERTS_FILE:-$HOME/Takeshi_Automation/state/ALERTS.md}"
REALERT_SECONDS=21600   # 6h
ts="$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M:%S %Z')"

note_alert() {
  local reason="$1"
  [[ -f "$ALERTS" ]] || return 0
  {
    printf '\n## [%s] vet402 本番監視が失敗 (uptime-cron)\n\n' "$ts"
    printf '%s\n\n' "$reason"
    printf 'ログ: `%s/%s`（末尾20行）\n\n```\n%s\n```\n' \
      "$(pwd)" "$LOG" "$(tail -20 "$LOG" 2>/dev/null)"
  } >>"$ALERTS"
}

# 2026-09-23: 会期中は支出上限を置かない判断（オーナー）。上限が無い以上、
# 止まる前に気づける値を毎回読む。Vercel の使用量 API は時間範囲が通らない
# （invalid_time_range を 3 形式で実測）ので、読めるのはチームの状態だけ:
#   billing.plan（pro から落ちていないか）と softBlock（fair use で止まっていないか）。
# 402 が出てからでは遅い面——ここで先に鳴らす。token は vercel CLI のものを読むだけで、
# 値はログにも ALERTS にも書かない。
check_vercel_team() {
  local auth="$HOME/Library/Application Support/com.vercel.cli/auth.json"
  [[ -f "$auth" ]] || return 0
  local token
  token=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("token",""))' "$auth" 2>/dev/null) || return 0
  [[ -n "$token" ]] || return 0
  local body
  body=$(curl -sL --max-time 20 -H "Authorization: Bearer $token" https://api.vercel.com/v2/teams/gokaku 2>/dev/null) || return 0
  python3 - "$body" <<'PYEOF' 2>/dev/null
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
plan = (d.get("billing") or {}).get("plan")
sb = d.get("softBlock")
if sb:
    print(f"VERCEL_TEAM_BLOCKED reason={sb.get('reason')} type={sb.get('blockedDueToOverageType')}")
elif plan and plan != "pro":
    print(f"VERCEL_TEAM_PLAN_CHANGED plan={plan}")
PYEOF
}

TEAM_NOTE="$(check_vercel_team)"
if [[ -n "$TEAM_NOTE" ]]; then
  printf '[%s] %s\n' "$ts" "$TEAM_NOTE" >>"$LOG"
  note_alert "$TEAM_NOTE — Vercel のチーム状態。プランか停止状態が変わった。課金ページ: https://vercel.com/gokaku/~/settings/billing"
fi

if OUT=$(./scripts/smoke-production.sh 2>&1); then
  printf '%s\n[%s] OK\n' "$OUT" "$ts" >>"$LOG"
  if [[ -f "$FAIL_MARKER" ]]; then
    # 復旧も記録する（鳴りっぱなしと復旧を区別できるように）。
    [[ -f "$ALERTS" ]] && printf '\n## [%s] vet402 本番監視が復旧 (uptime-cron)\n\n直前の失敗は解消。\n' "$ts" >>"$ALERTS"
  fi
  rm -f "$FAIL_MARKER"
else
  printf '%s\n[%s] FAIL (see %s)\n' "$OUT" "$ts" "$LOG" >>"$LOG"
  now=$(date +%s)
  last=0
  [[ -f "$FAIL_MARKER" ]] && last=$(sed -n '2p' "$FAIL_MARKER" 2>/dev/null || echo 0)
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if (( last == 0 || now - last >= REALERT_SECONDS )); then
    reason="$(printf '%s' "$OUT" | grep -m1 '^FAIL:' || echo 'smoke-production.sh が非ゼロ終了')"
    # 2026-09-23: 無料枠の超過でチームごと止まると全URLが 402 になる。原因は本文に出ず
    # ヘッダの x-vercel-error にしか無いので、ここで1回だけ引いて理由に書き足す。
    # 実測（09-23 06:24 JST）: softBlock = FAIL_USE… の hobby 停止で vet402/banto/agentrix が同時に 402。
    if printf '%s' "$OUT" | grep -q '402'; then
      verr="$(curl -sLI https://vet402.com/ 2>/dev/null | grep -i '^x-vercel-error:' | tr -d '\r')"
      case "$verr" in
        *DEPLOYMENT_DISABLED*)
          reason="$reason

Vercel がデプロイを止めている（$verr）。コードの不具合ではない。
無料枠の超過（fair use）か支払いが原因なので、`https://vercel.com/gokaku/~/settings/billing` を見る。
プランと停止の状態は次で読める（token は vercel CLI の auth.json）:
\`curl -sL -H \"Authorization: Bearer \$TOKEN\" https://api.vercel.com/v2/teams/gokaku\` の billing.plan と softBlock。
解除は有料プランへの切り替え＝オーナーの手番。"
          ;;
      esac
    fi
    note_alert "$reason"
    printf '%s\n%s\n' "$ts" "$now" >"$FAIL_MARKER"
  else
    # マーカーは維持したまま最終アラート時刻を保つ（連投しない）。
    printf '%s\n%s\n' "$ts" "$last" >"$FAIL_MARKER"
  fi
fi
