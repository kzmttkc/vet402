#!/bin/bash
# Commit one UTC day's root to the Stellar roots contract on testnet, keep the day's snapshot, and keep every
# committed day's root alive.
#   commit-day.sh [YYYY-MM-DD]     default: yesterday in UTC
# Without a date it does nothing before 14:30 UTC: vet402 re-checks settlements at 14:00 UTC, so yesterday's rows
# are settled by then. A scheduler can run it every hour. A day already committed is not committed again.
# Snapshots go to $VET402_ROOTS_STATE/days (default ~/.local/state/vet402-stellar-roots/days) and are copied into
# contracts/stellar-roots/days in the repository by hand with each push.
# No secrets are read here. The stellar CLI signs with its own testnet identity "vet402-roots-writer".
set -euo pipefail
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${VET402_ROOTS_STATE:-$HOME/.local/state/vet402-stellar-roots}"
CONTRACT="${VET402_ROOTS_CONTRACT:-CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB}"
# About 180 days of ledgers. The network caps it, and the call is repeated every run.
EXTEND_LEDGERS="${VET402_ROOTS_EXTEND_LEDGERS:-3000000}"
mkdir -p "$STATE/days"
LOG="$STATE/commit.log"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }
fail() { log "FAIL $*"; exit 1; }

if [ $# -ge 1 ]; then
  DATE="$1"
else
  now_min=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))
  if [ "$now_min" -lt $((14 * 60 + 30)) ]; then exit 0; fi
  DATE="$(node -e 'console.log(new Date(Date.now() - 86400000).toISOString().slice(0, 10))')"
fi

day_key() { stellar xdr encode --type ScVal "{\"vec\":[{\"symbol\":\"Root\"},{\"u32\":$1}]}"; }

# Keep every committed day alive (a root that is archived stops answering until it is restored).
extend_all() {
  for f in "$STATE"/days/*.committed; do
    [ -e "$f" ] || continue
    local d; d="$(basename "$f" .committed)"
    local n; n="$(node -e 'console.log(Math.floor(Date.parse(process.argv[1] + "T00:00:00Z") / 86400000))' "$d")"
    if ! stellar contract extend --id "$CONTRACT" --key-xdr "$(day_key "$n")" --durability persistent \
      --ledgers-to-extend "$EXTEND_LEDGERS" --source vet402-roots-writer --network testnet >/dev/null 2>&1; then
      log "extend failed for $d (day $n); next run tries again"
    fi
  done
}

if [ -f "$STATE/days/$DATE.committed" ]; then extend_all; exit 0; fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -sSfL -o "$TMP/export.csv" https://vet402.com/api/v1/observatory/export.csv || fail "$DATE: could not fetch the export"
set +e
node "$HERE/day.mjs" "$TMP/export.csv" "$DATE" "$TMP/day.json" > "$TMP/summary.json"
rc=$?
set -e
if [ $rc -eq 3 ]; then log "$DATE has no stellar:pubnet rows. Nothing to commit."; extend_all; exit 0; fi
[ $rc -eq 0 ] || fail "$DATE: day.mjs exited $rc"
read -r DAY ROOT COUNT < <(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s.day,s.root,s.count)' "$TMP/summary.json")

# The snapshot is kept before anything is sent, so a commit that lands without a readable answer still has it.
cp "$TMP/day.json" "$STATE/days/$DATE.json.pending"

onchain_root() {
  stellar contract invoke --id "$CONTRACT" --source vet402-roots-writer --network testnet --send=no -- get_root --day "$DAY" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{s=s.trim();if(!s||s==="null"){console.log("");return}console.log(JSON.parse(s).root)})'
}

EXISTING="$(onchain_root)" || fail "$DATE: could not read the chain"
if [ -z "$EXISTING" ]; then
  OUT="$(stellar contract invoke --id "$CONTRACT" --source vet402-roots-writer --network testnet -- commit_root --day "$DAY" --root "$ROOT" --count "$COUNT" 2>&1)" \
    || fail "$DATE: commit_root failed: $(printf '%s' "$OUT" | tail -1)"
  EXISTING="$(onchain_root)" || fail "$DATE: committed, then could not read the chain back"
fi
if [ "$EXISTING" != "$ROOT" ]; then
  fail "$DATE (day $DAY): the chain holds root $EXISTING, the snapshot $DATE.json.pending has $ROOT. Not marking it committed."
fi
mv "$STATE/days/$DATE.json.pending" "$STATE/days/$DATE.json"
TX="$(printf '%s\n' "${OUT:-}" | grep -o 'https://stellar.expert/explorer/testnet/tx/[0-9a-f]*' | head -1 || true)"
printf '%s\n' "${TX:-root on chain matches the snapshot}" > "$STATE/days/$DATE.committed"
log "$DATE (day $DAY) committed: $COUNT rows, root $ROOT ${TX:-}"
extend_all
