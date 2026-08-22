#!/usr/bin/env bash
set -euo pipefail

# Push production env vars to Vercel (values via environment).
# Required: DATABASE_URL, API_KEY_PEPPER, DASHBOARD_SESSION_SECRET, ADMIN_SECRET, CRON_SECRET

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 2026-08-23 監査 C-6: complete-stripe-setup.sh が DATABASE_URL / API_KEY_PEPPER /
# DASHBOARD_SESSION_SECRET / ADMIN_SECRET / CRON_SECRET を `placeholder` 既定で
# export してからこのスクリプトを呼び、`--force` で本番へ上書きしていた。
# 環境変数を揃えずに1回叩けば本番が起動不能になるか、最悪 ADMIN_SECRET=placeholder で
# 管理面が開く。不可逆・一撃。守りを2枚入れる:
#   1) 明らかな仮値を秘密として受け付けない（下の reject_placeholder）
#   2) 既存値の破壊上書きは VERCEL_ENV_FORCE=1 を明示したときだけ

SECRET_VARS=" DATABASE_URL API_KEY_PEPPER DASHBOARD_SESSION_SECRET ADMIN_SECRET CRON_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET "

reject_placeholder() {
  local name="$1" value="$2"
  case " $SECRET_VARS " in *" $name "*) ;; *) return 0 ;; esac
  local lower
  lower=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    placeholder|changeme|change-me|test|dummy|secret|todo|xxx|none|null)
      echo "REFUSED: $name looks like a placeholder ('$value')." >&2
      echo "  本番の秘密を仮値で上書きしようとしている。値を渡すか、この変数を外すこと。" >&2
      exit 1
      ;;
  esac
  if (( ${#value} < 16 )); then
    echo "REFUSED: $name is only ${#value} chars — too short for a production secret." >&2
    exit 1
  fi
}

add_env() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing $name" >&2
    exit 1
  fi
  reject_placeholder "$name" "$value"
  # ONLY で対象を絞れる（Stripe だけ更新したい、等）。指定が無ければ全部。
  if [[ -n "${VERCEL_ENV_ONLY:-}" && " ${VERCEL_ENV_ONLY} " != *" $name "* ]]; then
    echo "skip $name (not in VERCEL_ENV_ONLY)"
    return 0
  fi
  local ok=0
  if [[ "${VERCEL_ENV_FORCE:-}" == "1" ]]; then
    printf '%s' "$value" | vercel env add "$name" production --force >/dev/null 2>&1 || ok=1
  else
    printf '%s' "$value" | vercel env add "$name" production >/dev/null 2>&1 || ok=1
  fi
  if (( ok != 0 )); then
    echo "NOT SET: $name (already exists?). 上書きするなら VERCEL_ENV_FORCE=1 を明示すること。" >&2
    exit 1
  fi
  echo "set $name"
}

# 何かを push する前に、渡された秘密を**全部**検査する。1本ずつ検査しながら
# 書くと、先に通った分だけ本番へ入って途中で止まる（部分的に壊れた状態が残る）。
preflight() {
  local name
  for name in $SECRET_VARS; do
    local value="${!name:-}"
    [[ -z "$value" ]] && continue
    reject_placeholder "$name" "$value"
  done
  echo "preflight ok: 渡された秘密に仮値・短すぎる値は無い"
}

: "${DATABASE_URL:?DATABASE_URL required}"
: "${API_KEY_PEPPER:?API_KEY_PEPPER required}"
: "${DASHBOARD_SESSION_SECRET:?DASHBOARD_SESSION_SECRET required}"
: "${ADMIN_SECRET:?ADMIN_SECRET required}"
: "${CRON_SECRET:?CRON_SECRET required}"

preflight

add_env APP_ENV production
add_env DATABASE_URL "$DATABASE_URL"
add_env API_KEY_PEPPER "$API_KEY_PEPPER"
add_env DASHBOARD_SESSION_SECRET "$DASHBOARD_SESSION_SECRET"
add_env ADMIN_SECRET "$ADMIN_SECRET"
add_env CRON_SECRET "$CRON_SECRET"
add_env BASE_RPC_URL "${BASE_RPC_URL:-https://mainnet.base.org}"
# 2026-08-22: PROXY_HEADER_SOURCE supersedes TRUST_PROXY_HEADERS — it names
# WHICH forwarded header may be believed. `vercel` is correct here and only
# here; the app errors at boot if it is set while VERCEL=1 is absent.
# TRUST_PROXY_HEADERS is still written so a rollback to the previous build
# keeps its per-IP limits.
add_env PROXY_HEADER_SOURCE "${PROXY_HEADER_SOURCE:-vercel}"
add_env TRUST_PROXY_HEADERS "${TRUST_PROXY_HEADERS:-true}"
add_env BLOCKSCOUT_API_URL "${BLOCKSCOUT_API_URL:-https://base.blockscout.com/api}"

if [[ -n "${BETA_INVITE_CODE:-}" ]]; then
  add_env BETA_INVITE_CODE "$BETA_INVITE_CODE"
fi

if [[ -n "${STRIPE_SECRET_KEY:-}" ]]; then
  add_env STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY"
fi
if [[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]]; then
  add_env STRIPE_WEBHOOK_SECRET "$STRIPE_WEBHOOK_SECRET"
fi
if [[ -n "${STRIPE_PRICE_PRO:-}" ]]; then
  add_env STRIPE_PRICE_PRO "$STRIPE_PRICE_PRO"
fi
if [[ -n "${STRIPE_PRICE_SCALE:-}" ]]; then
  add_env STRIPE_PRICE_SCALE "$STRIPE_PRICE_SCALE"
fi
if [[ -n "${NEXT_PUBLIC_APP_URL:-}" ]]; then
  add_env NEXT_PUBLIC_APP_URL "$NEXT_PUBLIC_APP_URL"
fi

echo "Vercel production env configured."
