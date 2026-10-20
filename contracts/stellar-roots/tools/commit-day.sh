#!/bin/bash
# Commit one UTC day's root to the Stellar roots contract on testnet, and keep the day's snapshot.
#   commit-day.sh [YYYY-MM-DD]     default: the UTC day before yesterday's end, i.e. today (UTC) minus 1
# Run it after 14:30 UTC: vet402 re-checks settlements at 14:00 UTC, so the day before is settled by then.
# Snapshots go to $VET402_ROOTS_STATE/days (default ~/.local/state/vet402-stellar-roots/days) and are copied into
# contracts/stellar-roots/days in the repository by hand with each push. A day already committed is skipped.
# No secrets are read here: the stellar CLI signs with its own testnet identity "vet402-roots-writer".
set -euo pipefail
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${VET402_ROOTS_STATE:-$HOME/.local/state/vet402-stellar-roots}"
CONTRACT="${VET402_ROOTS_CONTRACT:-CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB}"
DATE="${1:-$(date -u -v-1d +%Y-%m-%d)}"
mkdir -p "$STATE/days"
LOG="$STATE/commit.log"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }

if [ -f "$STATE/days/$DATE.committed" ]; then log "$DATE already committed"; exit 0; fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -sSfL -o "$TMP/export.csv" https://vet402.com/api/v1/observatory/export.csv
set +e
node "$HERE/day.mjs" "$TMP/export.csv" "$DATE" "$TMP/day.json" > "$TMP/summary.json"
rc=$?
set -e
if [ $rc -eq 3 ]; then log "$DATE has no stellar:pubnet rows; nothing to commit"; exit 0; fi
[ $rc -eq 0 ] || { log "$DATE: day.mjs failed ($rc)"; exit $rc; }
read -r DAY ROOT COUNT < <(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s.day,s.root,s.count)' "$TMP/summary.json")
EXISTING="$(stellar contract invoke --id "$CONTRACT" --source vet402-roots-writer --network testnet --send=no -- get_root --day "$DAY" 2>/dev/null || true)"
if [ -n "$EXISTING" ] && [ "$EXISTING" != "null" ]; then
  log "$DATE (day $DAY) already has a root on chain: $EXISTING"
  cp "$TMP/day.json" "$STATE/days/$DATE.json.onchain-exists"
  exit 0
fi
OUT="$(stellar contract invoke --id "$CONTRACT" --source vet402-roots-writer --network testnet -- commit_root --day "$DAY" --root "$ROOT" --count "$COUNT" 2>&1)"
TX="$(printf '%s\n' "$OUT" | grep -o 'https://stellar.expert/explorer/testnet/tx/[0-9a-f]*' | head -1)"
[ -n "$TX" ] || { log "$DATE: commit_root failed: $(printf '%s' "$OUT" | tail -1)"; exit 1; }
cp "$TMP/day.json" "$STATE/days/$DATE.json"
printf '%s\n' "$TX" > "$STATE/days/$DATE.committed"
log "$DATE (day $DAY) committed: $COUNT rows, root $ROOT, $TX"
