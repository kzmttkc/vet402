#!/usr/bin/env bash
# Mutation checks for the seller-requested one-shot L1 retest (2026-10-30, fix round 2).
#
# 1. Baseline: every targeted test in tests/l1-seller-retest.pg.test.ts passes with no patch. Otherwise FAIL and stop.
# 2. Each mutation removes one guard (no inverted conditions, no syntax damage), runs only the paired tests
#    (--test-name-pattern placed BEFORE the file), and prints PASS only when at least one test ran and every
#    targeted test that failed did so with an assertion (ERR_ASSERTION). Zero tests, a syntax/import error,
#    a hook failure or a command crash prints FAIL.
# 3. Every patched file is restored (git checkout) and the real index SQL is re-applied; the script ends with
#    `git diff --exit-code` on those files.
#
# Usage: TEST_DATABASE_URL=postgres://localhost/vet402_test_x scripts/dev/mutation-check-seller-retest.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  echo "FAIL: TEST_DATABASE_URL is required" >&2
  exit 1
fi
case "$TEST_DATABASE_URL" in
  *neon.tech*) echo "FAIL: refusing to run against Neon" >&2; exit 1 ;;
esac

export OBSERVATORY_SELLER_RETEST_TEST_LIST=1
export DATABASE_URL="$TEST_DATABASE_URL"
PSQL="psql"
[[ -x /opt/homebrew/bin/psql ]] && PSQL=/opt/homebrew/bin/psql

PG_FILE="tests/l1-seller-retest.pg.test.ts"
INDEX_SQL="scripts/sql/2026-10-30-seller-retest-request-id-unique.sql"
L1="src/lib/observatory/l1-runner.ts"
SR="src/lib/observatory/seller-retest.ts"
SRQ="src/lib/observatory/seller-retest-requests.ts"
COV="src/lib/observatory/coverage.ts"
READER="src/lib/observatory/reader.ts"
PRIO="src/lib/observatory/reprobe-priority.ts"
RULE="src/lib/observatory/l0-rule-change-reprobe.ts"
TOUCHED=("$L1" "$SR" "$SRQ" "$COV" "$READER" "$PRIO" "$RULE" "$INDEX_SQL" "$PG_FILE")

if ! git diff --quiet -- "${TOUCHED[@]}"; then
  echo "FAIL: these files must be clean before mutation checks: ${TOUCHED[*]}" >&2
  exit 1
fi

WORK="$(mktemp -d)"
restore() {
  git checkout -- "${TOUCHED[@]}" 2>/dev/null
  "$PSQL" -q -v ON_ERROR_STOP=1 "$TEST_DATABASE_URL" -f "$INDEX_SQL" >/dev/null 2>&1
}
cleanup() {
  restore
  rm -rf "$WORK"
}
trap cleanup EXIT

# TAP judge. mode=baseline: each pattern matched >=1 test and none failed. mode=mutant: >=1 matching test ran,
# >=1 failed, and every matching failure is an assertion failure inside the test body.
cat >"$WORK/judge.js" <<'JS'
const fs = require("node:fs");
const [mode, file, ...patterns] = process.argv.slice(2);
const lines = fs.readFileSync(file, "utf8").split("\n");
const results = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(not ok|ok) \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  const name = m[2].replace(/ # (SKIP|TODO).*$/, "").replace(/\\#/g, "#");
  if (/\.test\.ts$/.test(name)) continue;
  const block = [];
  for (let j = i + 1; j < lines.length && !/^(not ok|ok) \d+ - /.test(lines[j]) && !/^# Subtest: /.test(lines[j]); j++) {
    block.push(lines[j]);
    if (lines[j] === "  ...") break;
  }
  const yaml = block.join("\n");
  results.push({ ok: m[1] === "ok", name, yaml, skipped: / # SKIP/.test(m[2]) });
}
const out = (s) => process.stdout.write(s + "\n");
if (mode === "baseline") {
  let bad = 0;
  for (const p of patterns) {
    const re = new RegExp(p);
    const hit = results.filter((r) => re.test(r.name) && !r.skipped);
    const failed = hit.filter((r) => !r.ok);
    if (hit.length === 0) { out(`  baseline: no test matched /${p}/`); bad++; }
    else if (failed.length > 0) { out(`  baseline: /${p}/ failed without a patch: ${failed.map((r) => r.name).join(" | ")}`); bad++; }
    else out(`  baseline ok: /${p}/ -> ${hit.map((r) => r.name).join(" | ")}`);
  }
  process.exit(bad === 0 ? 0 : 1);
}
const re = new RegExp(patterns[0]);
const hit = results.filter((r) => re.test(r.name) && !r.skipped);
const failed = hit.filter((r) => !r.ok);
const notAssert = failed.filter(
  (r) => !/code: 'ERR_ASSERTION'/.test(r.yaml) || !/failureType: 'testCodeFailure'/.test(r.yaml),
);
const others = results.filter((r) => !r.ok && !re.test(r.name));
if (hit.length === 0) { out("ran=0"); process.exit(2); }
if (others.length > 0) { out(`non-target failure: ${others.map((r) => r.name).join(" | ")}`); process.exit(2); }
if (failed.length === 0) { out(`ran=${hit.length} failed=0`); process.exit(1); }
if (notAssert.length > 0) { out(`ran=${hit.length} failed=${failed.length} non-assertion failure: ${notAssert.map((r) => r.name).join(" | ")}`); process.exit(2); }
out(`ran=${hit.length} failed=${failed.length} (assertion): ${failed.map((r) => r.name).join(" | ")}`);
process.exit(0);
JS

run_tap() {
  # $1 = name pattern, $2 = output file. The pattern goes before the file so node applies it.
  npx tsx --test --test-force-exit --test-concurrency=1 --test-reporter=tap --test-name-pattern "$1" "$PG_FILE" >"$2" 2>&1
}

# Patterns paired with each mutation (also the baseline set).
P_ORDINARY="BLOCK: ordinary L1 walk"
P_CENSUS="census only: seller_retest rows"
P_RETEST="retest only: seller_retest rows"
P_L0="L0 c1 tier excludes"
P_ARB="arbitrum lane on: seller request signs"
P_NET="network accept missing"
P_CAP="caps at 10 per run"
P_EXP="expired seller request is not bought"
P_CONC="concurrent claim: two auth-slot claims"
P_NO402="no_402 seller request: same day"
P_ENABLED="ENABLED=0 skips lane"
P_BODY="body mismatch is not signed"
P_STATS="public observatory counts exclude"
P_HALT="B2 halt after claim"
P_SWEEP="B2 orphan sweep"
P_RESOLVE="B2 resolve:"
P_PRIO="L0 priority reprobe excludes"
P_RULE="L0 rule-change reprobe excludes"
P_OVERVIEW="observatory overview list and count"
P_CHAIN="chain scope counts exclude"
ALL=("$P_ORDINARY" "$P_CENSUS" "$P_RETEST" "$P_L0" "$P_ARB" "$P_NET" "$P_CAP" "$P_EXP" "$P_CONC" "$P_NO402" "$P_ENABLED"
     "$P_BODY" "$P_STATS" "$P_HALT" "$P_SWEEP" "$P_RESOLVE" "$P_PRIO" "$P_RULE" "$P_OVERVIEW" "$P_CHAIN")

echo "== baseline (no patch)"
JOINED="$(IFS='|'; echo "${ALL[*]}")"
run_tap "$JOINED" "$WORK/baseline.tap"
if ! node "$WORK/judge.js" baseline "$WORK/baseline.tap" "${ALL[@]}"; then
  echo "FAIL: baseline — targeted tests do not all pass without a patch (TAP: $WORK/baseline.tap)"
  tail -40 "$WORK/baseline.tap"
  trap - EXIT; restore; exit 1
fi
echo "PASS: baseline (all targeted tests pass unpatched)"

FAILS=0
N=0
# mutate LABEL PATTERN FILE PERL_EXPR — apply one perl substitution (must change the file), run, judge, restore.
mutate() {
  local label="$1" pattern="$2" file="$3" expr="$4"
  N=$((N + 1))
  perl -0pi -e "$expr" "$file"
  if git diff --quiet -- "$file"; then
    echo "FAIL: $label (patch did not apply to $file)"
    FAILS=$((FAILS + 1)); restore; return
  fi
  finish "$label" "$pattern"
}
finish() {
  local label="$1" pattern="$2" verdict
  run_tap "$pattern" "$WORK/m$N.tap"
  verdict="$(node "$WORK/judge.js" mutant "$WORK/m$N.tap" "$pattern")"
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "PASS: $label — $verdict"
  else
    echo "FAIL: $label — $verdict (TAP: $WORK/m$N.tap)"
    FAILS=$((FAILS + 1))
  fi
  restore
}

echo "== mutations"
# Shared exclusion in the L1 coreWhere (primary walk, census, retest).
for pair in "ordinary walk|$P_ORDINARY" "census only|$P_CENSUS" "retest only|$P_RETEST"; do
  mutate "coreWhere exclusion removed -> ${pair%%|*}" "${pair#*|}" "$L1" 's/\n[ \t]*AND \$\{notSellerRetestRequestSourceSql\(\)\}\n/\n/'
done
mutate "L0 tier exclusion removed" "$P_L0" "$COV" 's/ AND \$\{notSellerRetestRequestSourceSql\(\)\}//'
mutate "network filter for signing removed (Arbitrum lane ON)" "$P_ARB" "$L1" \
  's/accepts: sellerRequestAccepts\(challenge\.accepts, candidate\.sellerRequest\)/accepts: challenge.accepts/'
mutate "network check in the 402 gate removed" "$P_NET" "$SR" \
  's/const accepts = challenge\.accepts\.filter\(\(a\) => a\.network === gate\.network\);/const accepts = challenge.accepts;/'
mutate "per-run cap removed" "$P_CAP" "$SRQ" \
  's/export const SELLER_RETEST_MAX_PER_RUN = 10;/export const SELLER_RETEST_MAX_PER_RUN = Number.MAX_SAFE_INTEGER;/'
mutate "expiry check removed" "$P_EXP" "$SR" 's/return todayUtc <= req\.expiresOn;/return true;/'

# One-shot DB guard: the real migration file becomes a no-op and the index is dropped.
N=$((N + 1))
perl -0pi -e 's/CREATE UNIQUE INDEX IF NOT EXISTS x402_l1_purchases_seller_request_id_auth_unique[\s\S]*?;/SELECT 1;/' "$INDEX_SQL"
if git diff --quiet -- "$INDEX_SQL"; then
  echo "FAIL: unique index removed (patch did not apply)"; FAILS=$((FAILS + 1))
else
  "$PSQL" -q -v ON_ERROR_STOP=1 "$TEST_DATABASE_URL" -c "DROP INDEX IF EXISTS x402_l1_purchases_seller_request_id_auth_unique" >/dev/null
  finish "unique index removed (migration no-op + DROP INDEX)" "$P_CONC"
fi

mutate "once-per-UTC-day gate removed" "$P_NO402" "$SR" \
  's/if \(attemptedToday\.has\(req\.id\)\) continue;/if (false \&\& attemptedToday.has(req.id)) continue;/'
mutate "6-day window counts failed unsigned rows again" "$P_NO402" "$L1" \
  's/\{ dupCredentialOnly: true \}/{ dupCredentialOnly: false }/'
mutate "ENABLED off variants reduced to \"false\"" "$P_ENABLED" "$SRQ" \
  's/return v === "false" \|\| v === "0" \|\| v === "off" \|\| v === "no";/return v === "false";/'
mutate "POST body check condition forced false" "$P_BODY" "$L1" \
  's/const sellerBodyMismatch = /const sellerBodyMismatch = false \&\& /'
mutate "public stats exclusion removed" "$P_STATS" "$READER" 's/ AND \$\{notSellerRetestRequestSourceSql\(\)\}//g'
mutate "B2 release treats only NULL as unsigned" "$P_HALT" "$L1" \
  's/const releaseUnsignedWhere = unsignedAuthNonceSql\(\);/const releaseUnsignedWhere = sql`auth_nonce IS NULL`;/'
mutate "B2 orphan sweep treats only NULL as unsigned" "$P_SWEEP" "$L1" \
  's/const sweepUnsigned = unsignedAuthNonceSql\(\);/const sweepUnsigned = sql`auth_nonce IS NULL`;/'
mutate "B2 resolve treats only NULL as unsigned" "$P_RESOLVE" "$L1" \
  's/const resolveUnsigned = unsignedAuthNonceSql\(\);/const resolveUnsigned = sql`auth_nonce IS NULL`;/'
mutate "released reservations counted as fetched today" "$P_HALT" "$SR" \
  's/\n[ \t]*AND NOT \$\{sellerRequestReservationReleasedSql\("pu"\)\}\n/\n/'
mutate "L0 priority reprobe exclusion removed" "$P_PRIO" "$PRIO" 's/\n[ \t]*AND \$\{notSellerRetestRequestSourceSql\(\)\}\n/\n/'
mutate "L0 rule-change reprobe exclusion removed" "$P_RULE" "$RULE" 's/ AND \$\{notSellerRetestRequestSourceSql\(\)\}//'
mutate "observatory overview exclusion removed" "$P_OVERVIEW" "$READER" \
  's/const overviewSellerExclusion = notSellerRetestRequestSourceSql\(\);/const overviewSellerExclusion = sql`TRUE`;/'
mutate "chain scope exclusion removed" "$P_CHAIN" "$READER" \
  's/const chainScopeSellerExclusion = notSellerRetestRequestSourceSql\(\);/const chainScopeSellerExclusion = sql`TRUE`;/'

trap - EXIT
restore
rm -rf "$WORK"
if ! git diff --exit-code -- "${TOUCHED[@]}"; then
  echo "FAIL: working tree not restored"
  exit 1
fi
if [[ $FAILS -ne 0 ]]; then
  echo "mutation-check-seller-retest: $FAILS of $N mutations FAILED"
  exit 1
fi
echo "mutation-check-seller-retest: all $N mutations PASS (baseline green, tree restored)"
