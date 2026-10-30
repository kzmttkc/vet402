#!/usr/bin/env bash
set -euo pipefail

# Catch up the identity-registry indexes (owner_agents + WalletSet) on production by calling
# /api/cron/index-owners in a loop until both reach the tip.
#
# 2026-10-31: each call now stops itself on a time budget (~180-230 s) and keeps every segment it
# finished, so a call that stops early still moves the checkpoints. The loop stops on the response's
# top-level "caughtUp" (parsed as JSON — the old grep also matched walletIndex.caughtUp and could stop
# while the owner index was still behind), on 403, or after 3 failed calls in a row.
# Only one run holds the "index-owners" lease at a time; a call that finds it held (for example the daily
# 05:00 UTC cron) answers {"ok":true,"skipped":"lease_held"} — that is not a failure, the loop waits
# LEASE_WAIT_SEC and calls again.
# Production ignores ?maxBlocks= (fixed 1,000,000 per call; the time budget is the real limit).
#
# Usage:
#   CRON_SECRET=... ./scripts/catch-up-owner-index.sh
#   CRON_SECRET=... MAX_RUNS=40 ./scripts/catch-up-owner-index.sh
#
# Local alternative (needs production DATABASE_URL + BASE_RPC_URL):
#   DATABASE_URL=... BASE_RPC_URL=... ./scripts/catch-up-owner-index.sh --local

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The old default (agent-trust-tawny.vercel.app) answers 308 since 2026-08-13; curl without -L got
# "Redirecting..." and the loop never saw caughtUp (scripts/smoke-production.sh has the same history).
PROD_URL="${PROD_URL:-https://vet402.com}"
MAX_RUNS="${MAX_RUNS:-40}"
MAX_BLOCKS="${MAX_BLOCKS:-1000000}"
SLEEP_SEC="${SLEEP_SEC:-2}"
MAX_FAILURES_IN_A_ROW="${MAX_FAILURES_IN_A_ROW:-3}"
LEASE_WAIT_SEC="${LEASE_WAIT_SEC:-30}"

# Reads the cron JSON on stdin; exits 0 only when the top-level caughtUp is true.
body_caught_up() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).caughtUp===true?0:1)}catch{process.exit(1)}})'
}
body_lease_held() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).skipped==="lease_held"?0:1)}catch{process.exit(1)}})'
}
body_ok() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})'
}
MODE="${1:-cron}"

run_local() {
  if [ -z "${DATABASE_URL:-}" ]; then
    if command -v npx >/dev/null 2>&1; then
      DATABASE_URL="$(npx neonctl connection-string main --project-id small-sun-02943444 --database-name vouch --pooled 2>/dev/null || true)"
      export DATABASE_URL
    fi
  fi
  : "${DATABASE_URL:?DATABASE_URL required for --local (set env or install neonctl)}"
  : "${BASE_RPC_URL:?BASE_RPC_URL required for --local}"

  for i in $(seq 1 "$MAX_RUNS"); do
    echo "==> local indexer run $i / $MAX_RUNS"
    OUT=$(npm run indexer:owners -- "$MAX_BLOCKS" 2>&1) || {
      echo "$OUT"
      echo "Indexer failed on run $i" >&2
      exit 1
    }
    echo "$OUT" | tail -8
    echo "$OUT" | tail -1 | body_caught_up && {
      echo "==> caught up"
      exit 0
    }
    sleep "$SLEEP_SEC"
  done
  echo "==> reached MAX_RUNS ($MAX_RUNS) without catching up" >&2
  exit 2
}

run_cron() {
  : "${CRON_SECRET:?CRON_SECRET required}"

  failures=0
  waits=0
  i=0
  while [ "$i" -lt "$MAX_RUNS" ]; do
    i=$((i + 1))
    echo "==> cron index-owners run $i / $MAX_RUNS"
    # maxDuration is 300 s; give the response time to arrive after the function ends.
    RES=$(curl -s -m 320 -H "Authorization: Bearer $CRON_SECRET" \
      "$PROD_URL/api/cron/index-owners?maxBlocks=$MAX_BLOCKS") || RES=""
    echo "$RES"
    if echo "$RES" | grep -q '"error":"forbidden"'; then
      echo "CRON_SECRET rejected (403). Update Vercel CRON_SECRET and retry." >&2
      exit 1
    fi
    echo "$RES" | body_caught_up && {
      echo "==> caught up"
      exit 0
    }
    if echo "$RES" | body_lease_held; then
      # Not a run of ours: do not count it against MAX_RUNS (a daily cron holds it for up to ~5 min),
      # but give up if it never frees (MAX_LEASE_WAITS).
      i=$((i - 1))
      waits=$((waits + 1))
      if [ "$waits" -ge "${MAX_LEASE_WAITS:-40}" ]; then
        echo "==> the lease stayed held for $waits checks; stopping" >&2
        exit 1
      fi
      echo "another run holds the lease; waiting ${LEASE_WAIT_SEC}s"
      sleep "$LEASE_WAIT_SEC"
      continue
    fi
    if echo "$RES" | body_ok; then
      failures=0
    else
      failures=$((failures + 1))
      echo "run $i failed ($failures in a row)" >&2
      if [ "$failures" -ge "$MAX_FAILURES_IN_A_ROW" ]; then
        echo "==> $failures failed calls in a row; stopping" >&2
        exit 1
      fi
    fi
    sleep "$SLEEP_SEC"
  done
  echo "==> reached MAX_RUNS ($MAX_RUNS) without catching up" >&2
  exit 2
}

case "$MODE" in
  --local) run_local ;;
  cron|*) run_cron ;;
esac
