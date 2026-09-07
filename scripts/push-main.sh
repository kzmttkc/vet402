#!/usr/bin/env bash
# The only way into main. One command for: fetch -> rebase -> judge-check -> numbers
# (-> root npm test) -> push -> wait for CI. Replaces the hand-typed chain
# that was retyped 10+ times on 2026-09-07 (one typo, one parallel-branch
# collision that turned main red).
#
#   bash scripts/push-main.sh [--full] [--dry-run] [--no-wait]
#
#   --full     also run root `npm test` (TEST_DATABASE_URL unset) and require
#              the four `ℹ fail 0` lines (root / sdk / middleware / mcp)
#   --dry-run  `git push --dry-run`; nothing leaves this machine, no CI wait
#   --no-wait  push, but do not wait for the `ci` workflow (gh not required)
#
# Exit 1 on the first failed stage. Stages are NOT chained with &&: each one
# records its own exit code and the table at the end shows all of them
# (same style as judge-check.sh). A `grep | head` in a chain can turn a red
# suite green; test results are read from the runner's own `ℹ fail N` lines.
#
# A rebase conflict stops the script and leaves the rebase in progress on
# purpose — a human resolves it (`git status`, then `git rebase --continue`
# or `git rebase --abort`).

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="${TMPDIR:-/tmp}/vet402-push-main.$$"
mkdir -p "$LOGDIR"
SHARED_TREE="${VOUCH_SHARED_TREE:-$HOME/vouch}"
CI_WORKFLOW="ci"
CI_LOOKUP_TIMEOUT=120   # seconds to wait for the run to appear after push
CI_LOOKUP_INTERVAL=10

FULL=0; DRY_RUN=0; NO_WAIT=0
for arg in "$@"; do
  case "$arg" in
    --full)    FULL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --no-wait) NO_WAIT=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "push-main: unknown option: $arg" >&2; exit 1 ;;
  esac
done

NAMES=(); CODES=(); SECS=(); NOTES=()
T0=$(date +%s)

record() { # record <label> <code> <start-epoch> [note]
  local now; now=$(date +%s)
  NAMES+=("$1"); CODES+=("$2"); SECS+=("$((now - $3))"); NOTES+=("${4:-}")
}

table() {
  echo
  printf '%-3s %-26s %-6s %-6s %s\n' "#" "stage" "exit" "sec" "note"
  printf '%-3s %-26s %-6s %-6s %s\n' "--" "--------------------------" "----" "----" "----"
  local i
  for i in "${!NAMES[@]}"; do
    printf '%-3s %-26s %-6s %-6s %s\n' "$((i + 1))" "${NAMES[$i]}" "${CODES[$i]}" "${SECS[$i]}" "${NOTES[$i]}"
  done
  echo
  echo "push-main: total $(( $(date +%s) - T0 ))s — logs in $LOGDIR"
}

fail() { # fail <label> <start> <reason...>   -> prints reason, table, exit 1
  local label="$1" start="$2"; shift 2
  echo "FAIL  $label: $*"
  record "$label" 1 "$start" "$*"
  table
  exit 1
}

cd "$ROOT" || exit 1
echo "vet402 push-main"
echo "  repo:    $ROOT"
echo "  branch:  $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "  head:    $(git rev-parse --short HEAD 2>/dev/null)"
echo "  mode:    full=$FULL dry-run=$DRY_RUN no-wait=$NO_WAIT"
echo "  logs:    $LOGDIR"
echo

# ---------------------------------------------------------------- 1. preflight
S=$(date +%s)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$BRANCH" ] || fail preflight "$S" "not a git checkout"
[ "$BRANCH" != "main" ] || fail preflight "$S" "current branch is main; push from a topic branch"
[ "$BRANCH" != "HEAD" ] || fail preflight "$S" "detached HEAD; check out a topic branch"
[ ! -d "$(git rev-parse --git-path rebase-merge)" ] && [ ! -d "$(git rev-parse --git-path rebase-apply)" ] \
  || fail preflight "$S" "a rebase is already in progress; finish or abort it first"

# clean tree: any tracked change is fatal; untracked files are allowed only under a results/ dir
DIRTY=$(git status --porcelain --untracked-files=all | grep -vE '^\?\? (.*/)?results/' || true)
if [ -n "$DIRTY" ]; then
  echo "$DIRTY" | head -10 | sed 's/^/  /'
  fail preflight "$S" "working tree is not clean (only untracked files under results/ are allowed)"
fi

ORIGIN_URL=$(git remote get-url origin 2>/dev/null) || fail preflight "$S" "remote 'origin' is not configured"

if [ "$NO_WAIT" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  command -v gh >/dev/null 2>&1 || fail preflight "$S" "gh is not installed (use --no-wait to skip the CI wait)"
  gh auth status >/dev/null 2>&1 || fail preflight "$S" "gh is not authenticated (gh auth login, or --no-wait)"
fi
echo "ok    preflight: branch=$BRANCH clean origin=$ORIGIN_URL"
record preflight 0 "$S"

# ---------------------------------------------------------------- 2. fetch + rebase
S=$(date +%s)
git fetch origin >"$LOGDIR/fetch.log" 2>&1 || { tail -5 "$LOGDIR/fetch.log"; fail fetch "$S" "git fetch origin failed"; }
record fetch 0 "$S" "origin/main=$(git rev-parse --short origin/main)"

S=$(date +%s)
BEFORE=$(git rev-parse --short HEAD)
if ! git rebase origin/main >"$LOGDIR/rebase.log" 2>&1; then
  tail -15 "$LOGDIR/rebase.log" | sed 's/^/  | /'
  echo "  rebase left in progress on purpose: resolve, then 'git rebase --continue' (or --abort) and re-run."
  fail rebase "$S" "conflict rebasing $BRANCH onto origin/main"
fi
AFTER=$(git rev-parse --short HEAD)
AHEAD=$(git rev-list --count origin/main..HEAD)
[ "$AHEAD" -gt 0 ] || fail rebase "$S" "nothing to push: HEAD == origin/main"
echo "ok    rebase: $BEFORE -> $AFTER ($AHEAD commit(s) ahead of origin/main)"
record rebase 0 "$S" "$AHEAD ahead"

# ---------------------------------------------------------------- 3. judge-check (+ root npm test)
S=$(date +%s)
echo
bash "$ROOT/scripts/judge-check.sh" 2>&1 | tee "$LOGDIR/judge-check.log"
JC=${PIPESTATUS[0]}
echo
[ "$JC" -eq 0 ] || fail judge-check "$S" "exit $JC — not pushing"
record judge-check 0 "$S"

# ---------------------------------------------------------------- 3b. submission numbers
# 2026-09-08: the same check CI runs last ("Submission numbers are consistent with
# scripts/refresh-numbers.json"). Run it here, before the push, because on 09-08 a
# branch refreshed the numbers, then amended the commit; the amend moved HEAD out of
# the as_of window, CI went red on main and an automatic "CI red on main" issue opened.
# Same fix every time: `npm run refresh-numbers` after fetch+rebase, then commit.
S=$(date +%s)
if node "$ROOT/scripts/refresh-numbers.mjs" --check >"$LOGDIR/numbers.log" 2>&1; then
  echo "ok    numbers: $(tail -1 "$LOGDIR/numbers.log")"
  record numbers 0 "$S"
else
  sed 's/^/  | /' "$LOGDIR/numbers.log" | tail -15
  fail numbers "$S" "refresh-numbers --check is red — run 'npm run refresh-numbers' after the rebase, commit, re-run"
fi

if [ "$FULL" -eq 1 ]; then
  S=$(date +%s)
  echo "root: npm test (TEST_DATABASE_URL unset) ..."
  ( unset TEST_DATABASE_URL; npm test ) >"$LOGDIR/npm-test.log" 2>&1
  NT=$?
  ZERO=$(grep -cE '^ℹ fail 0$' "$LOGDIR/npm-test.log")
  RED=$(grep -cE '^ℹ fail [1-9]' "$LOGDIR/npm-test.log")
  if [ "$NT" -ne 0 ] || [ "$RED" -ne 0 ] || [ "$ZERO" -ne 4 ]; then
    grep -E '^ℹ (pass|fail) ' "$LOGDIR/npm-test.log" | sed 's/^/  | /'
    tail -20 "$LOGDIR/npm-test.log" | sed 's/^/  | /'
    fail "root: npm test" "$S" "exit $NT, 'ℹ fail 0' x$ZERO (need 4), red suites $RED — not pushing"
  fi
  echo "ok    root: npm test — 4 suites, all 'ℹ fail 0'"
  record "root: npm test" 0 "$S" "4/4 fail 0"
fi

# ---------------------------------------------------------------- 4. push (+ shared tree)
S=$(date +%s)
SHA=$(git rev-parse HEAD)
if [ "$DRY_RUN" -eq 1 ]; then
  if git push --dry-run origin HEAD:main >"$LOGDIR/push.log" 2>&1; then
    sed 's/^/  | /' "$LOGDIR/push.log"
    echo "ok    push (dry-run): would push ${SHA:0:7} -> origin/main"
    record "push (dry-run)" 0 "$S" "${SHA:0:7}"
  else
    sed 's/^/  | /' "$LOGDIR/push.log"
    fail "push (dry-run)" "$S" "git push --dry-run refused"
  fi
else
  if git push origin HEAD:main >"$LOGDIR/push.log" 2>&1; then
    sed 's/^/  | /' "$LOGDIR/push.log"
    echo "ok    push: ${SHA:0:7} -> origin/main"
    record push 0 "$S" "${SHA:0:7}"
  else
    sed 's/^/  | /' "$LOGDIR/push.log"
    fail push "$S" "git push origin HEAD:main refused (someone pushed first? re-run to rebase again)"
  fi
fi

S=$(date +%s)
SHARED_NOTE=""
if [ "$DRY_RUN" -eq 1 ]; then
  SHARED_NOTE="skipped (dry-run)"
elif [ ! -d "$SHARED_TREE/.git" ] && [ ! -f "$SHARED_TREE/.git" ]; then
  SHARED_NOTE="skipped ($SHARED_TREE is not a checkout)"
elif [ "$(git -C "$SHARED_TREE" rev-parse --show-toplevel 2>/dev/null)" = "$ROOT" ]; then
  SHARED_NOTE="skipped (this tree is the shared tree)"
elif [ "$(git -C "$SHARED_TREE" rev-parse --abbrev-ref HEAD 2>/dev/null)" != "main" ]; then
  SHARED_NOTE="WARN: $SHARED_TREE is on $(git -C "$SHARED_TREE" rev-parse --abbrev-ref HEAD), not main — not pulled"
elif [ -n "$(git -C "$SHARED_TREE" status --porcelain --untracked-files=no)" ]; then
  SHARED_NOTE="WARN: $SHARED_TREE is dirty — not pulled (pull --ff-only by hand)"
elif git -C "$SHARED_TREE" pull --ff-only origin main >"$LOGDIR/shared-pull.log" 2>&1; then
  SHARED_NOTE="ff to $(git -C "$SHARED_TREE" rev-parse --short HEAD)"
else
  tail -5 "$LOGDIR/shared-pull.log" | sed 's/^/  | /'
  SHARED_NOTE="WARN: pull --ff-only failed in $SHARED_TREE (see shared-pull.log)"
fi
echo "      shared tree ($SHARED_TREE): $SHARED_NOTE"
record "shared tree pull" 0 "$S" "$SHARED_NOTE"

# ---------------------------------------------------------------- 5. wait for CI
S=$(date +%s)
if [ "$DRY_RUN" -eq 1 ] || [ "$NO_WAIT" -eq 1 ]; then
  [ "$DRY_RUN" -eq 1 ] && CI_NOTE="skipped (dry-run)" || CI_NOTE="skipped (--no-wait)"
  echo "      ci: $CI_NOTE"
  record "ci wait" 0 "$S" "$CI_NOTE"
else
  RUN_ID=""
  DEADLINE=$(( $(date +%s) + CI_LOOKUP_TIMEOUT ))
  while [ -z "$RUN_ID" ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do
    RUN_ID=$(gh run list --workflow "$CI_WORKFLOW" --commit "$SHA" --limit 1 --json databaseId \
               --jq '.[0].databaseId // empty' 2>>"$LOGDIR/ci.log" || true)
    [ -n "$RUN_ID" ] || sleep "$CI_LOOKUP_INTERVAL"
  done
  [ -n "$RUN_ID" ] || fail "ci wait" "$S" "no '$CI_WORKFLOW' run for ${SHA:0:7} within ${CI_LOOKUP_TIMEOUT}s (check GitHub Actions by hand)"
  echo "      ci: run $RUN_ID for ${SHA:0:7} — watching ..."
  if gh run watch "$RUN_ID" --exit-status >>"$LOGDIR/ci.log" 2>&1; then
    echo "ok    ci: run $RUN_ID success"
    record "ci wait" 0 "$S" "run $RUN_ID success"
  else
    FAILED_JOBS=$(gh run view "$RUN_ID" --json jobs \
                    --jq '[.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | .name] | join(", ")' 2>/dev/null)
    echo "      failed jobs: ${FAILED_JOBS:-(unknown)}"
    echo "      $(gh run view "$RUN_ID" --json url --jq .url 2>/dev/null)"
    fail "ci wait" "$S" "run $RUN_ID failed — ${FAILED_JOBS:-see gh run view $RUN_ID}"
  fi
fi

table
echo "push-main: all ${#NAMES[@]} stages exit 0"
exit 0
