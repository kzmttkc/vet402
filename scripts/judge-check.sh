#!/usr/bin/env bash
# One command for a judge on a clean clone: build and test everything SKILL.md
# relies on, in the order the dependencies require, and print one table at the end.
#
#   npm run judge-check          # from the repo root
#   bash scripts/judge-check.sh  # same thing
#
# What it runs (no API keys, no live calls; the only network is the npm registry):
#   sdk:        npm ci -> npm run build -> npm test
#   mcp-server: npm ci -> npm run build -> npm test   (depends on packages/sdk via file:../sdk)
#   demo:       npm test                              (imports packages/sdk/dist, nothing to install)
#   root:       npm ci                                (kept for parity with CI's "examples" job; the A/B
#                                                      harness has viem as a direct dependency since 2026-09-07)
#   ab:         npm ci -> npm test -> node test-mutations.mjs
#
# Steps are NOT chained with &&: every step runs, its exit code is recorded on its own,
# and the script exits 1 if any step was non-zero. A `grep | head` in a chain can turn a
# red suite green; this script reads the runner's own `ℹ fail N` line instead.
#
# Any key that happens to be in the environment is dropped first, so a green run here is
# proof that none of this needs one.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="${TMPDIR:-/tmp}/vet402-judge-check.$$"
mkdir -p "$LOGDIR"

unset VOUCH_API_KEY GRAPH_API_KEY VOUCH_PAYER_PRIVATE_KEY DEMO_PAYER_PRIVATE_KEY ANTHROPIC_API_KEY

echo "vet402 judge-check"
echo "  repo:  $ROOT"
echo "  node:  $(node -v 2>/dev/null || echo 'not found')   npm: $(npm -v 2>/dev/null || echo 'not found')"
echo "  logs:  $LOGDIR"
echo

NAMES=()
CODES=()
FAILS=()
SECS=()
NOTES=()

# run <label> <relative dir> <command...>
run() {
  local label="$1" dir="$2"; shift 2
  local log="$LOGDIR/$(echo "$label" | tr ' /:' '___').log"
  local start end code fail note
  printf '%-28s ' "$label"
  start=$(date +%s)
  ( cd "$ROOT/$dir" && "$@" ) >"$log" 2>&1
  code=$?
  end=$(date +%s)
  # node --test prints "ℹ fail N"; the mutation scripts print "all N mutations killed" / "unkilled".
  fail=$(grep -E '^ℹ fail [0-9]+' "$log" | tail -1 | awk '{print $3}')
  note=$(grep -E 'mutations killed|unkilled|refusing to mutate|ERR_MODULE_NOT_FOUND|error TS[0-9]+' "$log" | tail -1 | cut -c1-70)
  NAMES+=("$label"); CODES+=("$code"); FAILS+=("${fail:--}"); SECS+=("$((end - start))"); NOTES+=("${note:-}")
  if [ "$code" -eq 0 ]; then
    printf 'ok    exit 0  fail %-3s %4ss\n' "${fail:--}" "$((end - start))"
  else
    printf 'FAIL  exit %-2s fail %-3s %4ss\n' "$code" "${fail:--}" "$((end - start))"
    echo "  --- last 15 lines of $log ---"
    tail -15 "$log" | sed 's/^/  | /'
    echo "  ---"
  fi
}

run "sdk: npm ci"                 packages/sdk                   npm ci
run "sdk: npm run build"          packages/sdk                   npm run build
run "sdk: npm test"               packages/sdk                   npm test
run "mcp-server: npm ci"          packages/mcp-server            npm ci
run "mcp-server: npm run build"   packages/mcp-server            npm run build
run "mcp-server: npm test"        packages/mcp-server            npm test
run "demo: npm test"              examples/ethonline-2026-demo   npm test
run "root: npm ci (parity with CI)"  .                              npm ci
run "ab: npm ci"                  examples/ethonline-2026-ab     npm ci
run "ab: npm test"                examples/ethonline-2026-ab     npm test
run "ab: node test-mutations.mjs" examples/ethonline-2026-ab     node test-mutations.mjs

echo
printf '%-3s %-28s %-6s %-5s %-6s %s\n' "#" "step" "exit" "fail" "sec" "note"
printf '%-3s %-28s %-6s %-5s %-6s %s\n' "--" "----------------------------" "----" "----" "----" "----"
bad=0
total=0
for i in "${!NAMES[@]}"; do
  printf '%-3s %-28s %-6s %-5s %-6s %s\n' "$((i + 1))" "${NAMES[$i]}" "${CODES[$i]}" "${FAILS[$i]}" "${SECS[$i]}" "${NOTES[$i]}"
  total=$((total + SECS[i]))
  [ "${CODES[$i]}" -ne 0 ] && bad=$((bad + 1))
done
echo
if [ "$bad" -eq 0 ]; then
  echo "judge-check: all ${#NAMES[@]} steps exit 0 in ${total}s"
  exit 0
else
  echo "judge-check: $bad of ${#NAMES[@]} steps failed (${total}s) — logs in $LOGDIR"
  exit 1
fi
