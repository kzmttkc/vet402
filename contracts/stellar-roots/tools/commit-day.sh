#!/bin/bash
# Commit UTC days' roots to the Stellar roots contract on testnet, keep each day's snapshot, and keep the contract
# and every committed root alive.
#   commit-day.sh YYYY-MM-DD    one day
#   commit-day.sh               every day of the last 14 up to yesterday (UTC) that is not committed or known empty
# Without a date it does nothing before 14:30 UTC: vet402 re-checks settlements at 14:00 UTC, so yesterday's rows
# are settled by then. A scheduler can run it every hour. A day already committed is not committed again, and a day
# missed while the machine was asleep is picked up on the next run.
# Snapshots go to $VET402_ROOTS_STATE/days (default ~/.local/state/vet402-stellar-roots/days) and are copied into
# contracts/stellar-roots/days in the repository by hand with each push.
# No secrets are read here. The stellar CLI signs with its own testnet identity "vet402-roots-writer".
set -euo pipefail
# VET402_ROOTS_PATH_PREFIX lets a test put fake stellar/curl first (they would otherwise be the real ones in /opt/homebrew/bin).
PATH="${VET402_ROOTS_PATH_PREFIX:+$VET402_ROOTS_PATH_PREFIX:}/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${VET402_ROOTS_STATE:-$HOME/.local/state/vet402-stellar-roots}"
CONTRACT="${VET402_ROOTS_CONTRACT:-CCWWBZ2GBKDPRSUMT32CPB7LBUGHHKL37R5YNQC6RAWRV6PVIEKOBKRB}"
WASM_HASH="${VET402_ROOTS_WASM_HASH:-4ff8e33502298ebf9bc4e8434a6c74fce26f96b7a9bc14c193739207390b0c07}"
# The first UTC day the contract covers. Days before it are never tried.
FIRST_DAY="${VET402_ROOTS_FIRST_DAY:-2026-10-18}"
# About 180 days of ledgers. The network caps it. It is renewed once per UTC day.
EXTEND_LEDGERS="${VET402_ROOTS_EXTEND_LEDGERS:-3000000}"
# Where a failure is said out loud (one line). A missing file means the log only.
ALERTS="${VET402_ROOTS_ALERTS:-$STATE/ALERTS.md}"
mkdir -p "$STATE/days"
LOG="$STATE/commit.log"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }
alert() {
  log "FAIL $*"
  if [ -f "$ALERTS" ]; then
    printf '[%s] vet402 stellar-roots (testnet): %s (log: %s)\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" "$LOG" >> "$ALERTS" || true
  fi
}

day_number() { node -e 'console.log(Math.floor(Date.parse(process.argv[1] + "T00:00:00Z") / 86400000))' "$1"; }
day_key() { stellar xdr encode --type ScVal "{\"vec\":[{\"symbol\":\"Root\"},{\"u32\":$1}]}"; }
writer_call() { stellar "$@" --source vet402-roots-writer --network testnet; }

# Keep the contract instance, its wasm code and every committed root alive. An archived entry stops answering until
# it is restored, and the instance and code otherwise only get life when a root is committed.
extend_all() {
  local today mark failed=0
  today="$(date -u +%Y-%m-%d)"
  mark="$STATE/extended-$today"
  [ -e "$mark" ] && return 0
  writer_call contract extend --id "$CONTRACT" --durability persistent --ledgers-to-extend "$EXTEND_LEDGERS" >/dev/null 2>&1 \
    || { log "extend of the contract instance failed"; failed=1; }
  writer_call contract extend --wasm-hash "$WASM_HASH" --durability persistent --ledgers-to-extend "$EXTEND_LEDGERS" >/dev/null 2>&1 \
    || { log "extend of the contract code failed"; failed=1; }
  for f in "$STATE"/days/*.committed; do
    [ -e "$f" ] || continue
    local d n
    d="$(basename "$f" .committed)"
    n="$(day_number "$d")"
    writer_call contract extend --id "$CONTRACT" --key-xdr "$(day_key "$n")" --durability persistent \
      --ledgers-to-extend "$EXTEND_LEDGERS" >/dev/null 2>&1 || { log "extend failed for $d (day $n)"; failed=1; }
  done
  if [ $failed -eq 0 ]; then
    rm -f "$STATE"/extended-* "$STATE"/extend-alerted-*
    : > "$mark"
  else
    if [ ! -e "$STATE/extend-alerted-$today" ]; then
      alert "keeping the contract alive failed on $today (see the log). The next hourly run tries again."
      : > "$STATE/extend-alerted-$today"
    fi
  fi
}

onchain_root() {
  writer_call contract invoke --id "$CONTRACT" --send=no -- get_root --day "$1" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{s=s.trim();if(!s||s==="null"){console.log("");return}console.log(JSON.parse(s).root)})'
}

EXPORT=""
fetch_export() {
  [ -n "$EXPORT" ] && return 0
  curl -sSfL -o "$TMP/export.csv" https://vet402.com/api/v1/observatory/export.csv || return 1
  EXPORT="$TMP/export.csv"
}

# Commit one day. Returns 0 when the day is committed or has no rows, 1 on a failure (already said out loud).
commit_one() {
  local date="$1" pending="$STATE/days/$1.json.pending" snap="$TMP/$1.json"
  [ -f "$STATE/days/$date.committed" ] && return 0
  [ -f "$STATE/days/$date.empty" ] && return 0
  if [ -f "$pending" ]; then
    # A snapshot from an earlier run that sent or may have sent. Keep it: the root on chain, if any, covers it.
    cp "$pending" "$snap"
  else
    fetch_export || { alert "$date: could not fetch the export"; return 1; }
    local rc=0
    node "$HERE/day.mjs" "$EXPORT" "$date" "$snap" > /dev/null || rc=$?
    if [ $rc -eq 3 ]; then log "$date has no stellar:pubnet rows. Nothing to commit."; : > "$STATE/days/$date.empty"; return 0; fi
    [ $rc -eq 0 ] || { alert "$date: day.mjs exited $rc"; return 1; }
    cp "$snap" "$pending"
  fi
  local day root count existing out tx
  read -r day root count < <(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s.day,s.root,s.count)' "$snap")
  existing="$(onchain_root "$day")" || { alert "$date: could not read the chain"; return 1; }
  out=""
  if [ -z "$existing" ]; then
    out="$(writer_call contract invoke --id "$CONTRACT" -- commit_root --day "$day" --root "$root" --count "$count" 2>&1)" \
      || { alert "$date: commit_root failed: $(printf '%s' "$out" | tail -1)"; return 1; }
    existing="$(onchain_root "$day")" || { alert "$date: committed, then could not read the chain back"; return 1; }
  fi
  if [ "$existing" != "$root" ]; then
    alert "$date (day $day): the chain holds root $existing, the snapshot $date.json.pending has $root. Not marking it committed."
    return 1
  fi
  mv "$pending" "$STATE/days/$date.json"
  tx="$(printf '%s\n' "$out" | grep -o 'https://stellar.expert/explorer/testnet/tx/[0-9a-f]*' | head -1 || true)"
  printf '%s\n' "${tx:-root on chain matches the snapshot}" > "$STATE/days/$date.committed"
  log "$date (day $day) committed: $count rows, root $root ${tx:-}"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ $# -ge 1 ]; then
  DATES=("$1")
else
  now_min=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))
  if [ "$now_min" -lt $((14 * 60 + 30)) ]; then exit 0; fi
  # Every day in the last 14 (up to yesterday, UTC, and not before the contract's first day) that is neither
  # committed nor known to be empty. A day that failed for any reason stays in this list until it succeeds.
  DATES=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ -e "$STATE/days/$line.committed" ] || [ -e "$STATE/days/$line.empty" ] || DATES+=("$line")
  done < <(node -e '
    const start = process.argv[1];
    const y = Date.parse(new Date(Date.now() - 86400000).toISOString().slice(0, 10) + "T00:00:00Z");
    const out = [];
    for (let t = y - 13 * 86400000; t <= y; t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d >= start) out.push(d);
    }
    console.log(out.join("\n"));' "$FIRST_DAY")
fi
status=0
for d in "${DATES[@]+"${DATES[@]}"}"; do
  [ -n "$d" ] || continue
  commit_one "$d" || status=1
done
extend_all
exit $status
