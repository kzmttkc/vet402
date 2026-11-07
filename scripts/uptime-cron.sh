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

# 2026-10-13: 10/8 から 5 日、`/api/health` が degraded のまま誰も動かなかった。知らせは 6 時間ごとに
# ALERTS へ出ていたが、本文は毎回「FAIL: health http 503 (body: {"status":"degraded"})」の 1 行で、
# どの検査が落ちているのか・いつから続いているのかが読めず、同じ見出しとして畳まれていた。
# 落ちている検査の名前（deep health の checks。値は ok / lagging / degraded などの語だけで、秘密は無い）を
# 取って知らせに足す。取れなければ何も足さない（知らせ自体は必ず出す）。
failing_checks() {
  [[ -n "${CRON_SECRET:-}" ]] || return 0
  local body
  body=$(curl -sL --max-time 40 -H "Authorization: Bearer $CRON_SECRET" \
    "${PROD_URL:-https://vet402.com}/api/cron/monitor-health" 2>/dev/null) || return 0
  python3 - "$body" <<'PYEOF' 2>/dev/null
import json, re, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
checks = d.get("checks")
if not isinstance(checks, dict):
    sys.exit(0)
fine = {"ok", "off", "unconfigured", "skipped"}
bad = []
for k, v in checks.items():
    if not isinstance(v, str) or v in fine:
        continue
    # 数字だけの値（blocks_behind など）は状態ではなく量。落ちている検査の隣にあるときだけ意味があるので後で足す。
    if re.fullmatch(r"\d+", v):
        continue
    extra = checks.get(k + "_blocks_behind")
    bad.append(f"{k}={v}" + (f"（{extra} ブロック遅れ）" if isinstance(extra, str) and extra.isdigit() else ""))
if bad:
    print("落ちている検査: " + " / ".join(bad[:12]))
PYEOF
}

TEAM_NOTE="$(check_vercel_team)"
if [[ -n "$TEAM_NOTE" ]]; then
  printf '[%s] %s\n' "$ts" "$TEAM_NOTE" >>"$LOG"
  note_alert "$TEAM_NOTE — Vercel のチーム状態。プランか停止状態が変わった。課金ページ: https://vercel.com/gokaku/~/settings/billing"
fi

# 前の回の deep の本文を、下のブロック間隔の判定で読み違えないように消してから測る。
rm -f /tmp/vouch-monitor.json
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
  # 3 行目 = この失敗が始まった時刻（epoch）。10/13 より前のマーカーには無いので、
  # そのときは分かっているいちばん古い時刻（最後に知らせた時刻）から数える。
  first=""
  [[ -f "$FAIL_MARKER" ]] && first=$(sed -n '3p' "$FAIL_MARKER" 2>/dev/null || echo "")
  [[ "$first" =~ ^[0-9]+$ ]] || first=$(( last > 0 ? last : now ))
  if (( last == 0 || now - last >= REALERT_SECONDS )); then
    reason="$(printf '%s' "$OUT" | grep -m1 '^FAIL:' || echo 'smoke-production.sh が非ゼロ終了')"
    hours=$(( (now - first) / 3600 ))
    if (( hours >= 1 )); then
      reason="$reason

**この失敗は ${hours} 時間続いている**（始まり: $(TZ=Asia/Tokyo date -r "$first" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || echo "epoch $first")）。同じ知らせが 6 時間ごとに出ているなら、まだ誰も直していない。"
    fi
    checks_note="$(failing_checks)"
    [[ -n "$checks_note" ]] && reason="$reason

$checks_note"
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
    printf '%s\n%s\n%s\n' "$ts" "$now" "$first" >"$FAIL_MARKER"
  else
    # マーカーは維持したまま最終アラート時刻を保つ（連投しない）。
    printf '%s\n%s\n%s\n' "$ts" "$last" "$first" >"$FAIL_MARKER"
  fi
fi

# 2026-11-08: ブロック間隔の変化を 1 回だけ知らせる。deep health の block_interval / block_schedule は
# 重大扱いにしていない（monitor-health の 503 は smoke では失敗にならない）ので、ここで拾わないと誰にも届かない。
# 11/05 の Base の 2 秒 → 0.2 秒は 2 日気づかなかった。smoke が書いた /tmp/vouch-monitor.json を読むだけで、
# 追加の呼び出しはしない。マーカーがある間は書かず、戻ったら復旧を 1 行書く。
INTERVAL_MARKER="logs/block-interval.ALERTED"
interval_note=$(python3 - /tmp/vouch-monitor.json <<'PYEOF' 2>/dev/null
import json, sys
try:
    checks = json.load(open(sys.argv[1])).get("checks") or {}
except Exception:
    sys.exit(0)
bad = []
bi = checks.get("block_interval")
if isinstance(bi, str) and bi.startswith("drift"):
    bad.append(f"block_interval={bi}")
if checks.get("block_schedule") == "drift":
    bad.append(f"block_schedule=drift（{checks.get('block_schedule_drift_s', '?')} 秒ずれ）")
if bad:
    print("DRIFT " + " / ".join(bad))
elif bi == "ok" and checks.get("block_schedule") == "ok":
    # 解消と言えるのは両方を実際に測って ok だったときだけ。401/403 の本文や unknown は解消ではない。
    print("RESOLVED")
PYEOF
)
if [[ "$interval_note" == DRIFT* ]]; then
  interval_note="${interval_note#DRIFT }"
  if [[ ! -f "$INTERVAL_MARKER" ]]; then
    note_alert "チェーンのブロック間隔が、時間の窓が前提にしている値から 2 倍以上ずれた: $interval_note
窓と遅れの判定（src/lib/chain/chains.ts の blocksPerDay・block-clock.ts の履歴、src/lib/settlements/index-evm.ts）を実測に合わせる。どのチェーンかは https://vet402.com/status の 2 節にも出る。"
    printf '%s\n%s\n' "$ts" "$interval_note" >"$INTERVAL_MARKER"
  fi
elif [[ "$interval_note" == "RESOLVED" ]] && [[ -f "$INTERVAL_MARKER" ]]; then
  [[ -f "$ALERTS" ]] && printf '\n## [%s] vet402 ブロック間隔のずれが解消 (uptime-cron)\n\n直前の知らせは解消。\n' "$ts" >>"$ALERTS"
  rm -f "$INTERVAL_MARKER"
fi

# 2026-11-08: 公開ページの速さ。審査員は 1 回だけ開くので、冷えた 1 回が遅いと 11 秒に見える
# （11/07 実測: /accuracy 初回 11.18 秒）。最初の 1 バイトまでが目標 0.8 秒を 3 回続けて超えたページを、
# 1 回だけ知らせる。この呼び出し自体が 30 分ごとにキャッシュを温める。
PAGE_TARGET_S="0.8"
PAGE_STATE="logs/page-speed.state"
PAGE_MARKER="logs/page-speed.ALERTED"
page_slow=""
new_state=""
for path in / /about /accuracy /impact /sellers /observatory /status /api/v1/observatory/state; do
  t=$(curl -sL -o /dev/null --max-time 20 -w '%{time_starttransfer}' "${PROD_URL:-https://vet402.com}$path" 2>/dev/null || echo "")
  prev=$(grep -m1 "^$path " "$PAGE_STATE" 2>/dev/null | awk '{print $2}')
  [[ "$prev" =~ ^[0-9]+$ ]] || prev=0
  if [[ -z "$t" ]] || [[ "$t" == "0.000000" ]]; then
    n=$prev   # 測れなかった回は数えも戻しもしない（ネットに出られない Mac）
  elif awk -v a="$t" -v b="$PAGE_TARGET_S" 'BEGIN{exit !(a>b)}'; then
    n=$((prev + 1))
  else
    n=0
  fi
  new_state+="$path $n $t"$'\n'
  (( n >= 3 )) && page_slow+="$path ${t}s（${n} 回連続）、"
done
printf '%s' "$new_state" >"$PAGE_STATE"
printf '[%s] page-speed %s\n' "$ts" "$(printf '%s' "$new_state" | awk '{printf "%s=%s ", $1, $3}')" >>"$LOG"
if [[ -n "$page_slow" ]]; then
  if [[ ! -f "$PAGE_MARKER" ]]; then
    note_alert "公開ページの最初の 1 バイトまでが目標 ${PAGE_TARGET_S} 秒を 3 回続けて超えた: ${page_slow%、}
キャッシュ（ISR・データキャッシュ）が効いているか、x-vercel-cache と Cache-Control を curl -sIL で見る。"
    printf '%s\n%s\n' "$ts" "$page_slow" >"$PAGE_MARKER"
  fi
elif [[ -f "$PAGE_MARKER" ]]; then
  [[ -f "$ALERTS" ]] && printf '\n## [%s] vet402 公開ページの速さが目標に戻った (uptime-cron)\n\n直前の知らせは解消。\n' "$ts" >>"$ALERTS"
  rm -f "$PAGE_MARKER"
fi
