#!/usr/bin/env bash
# Mutation checks for seller-retest fix round (2026-10-30).
# Reverts one guard at a time; the paired pg test must fail (PASS). Restores tree at end.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  echo "TEST_DATABASE_URL is required" >&2
  exit 1
fi

export OBSERVATORY_SELLER_RETEST_TEST_LIST=1
export DATABASE_URL="$TEST_DATABASE_URL"

PG_FILE="tests/l1-seller-retest.pg.test.ts"
RUN=(npx tsx --test --test-force-exit --test-concurrency=1 "$PG_FILE")

pass_line() { echo "PASS: $1"; }
fail_line() { echo "FAIL: $1"; exit 1; }

run_expect_fail() {
  local label="$1"
  local pattern="$2"
  if "${RUN[@]}" --test-name-pattern "$pattern" >/dev/null 2>&1; then
    fail_line "$label (test still passed after mutation)"
  else
    pass_line "$label"
  fi
}

if ! git diff --quiet; then
  echo "Working tree must be clean before mutation checks" >&2
  exit 1
fi

# 1. BLOCK ordinary L1
sed -i '' '/AND \${notSellerRetestRequestSourceSql()}/d' src/lib/observatory/l1-runner.ts
run_expect_fail "BLOCK ordinary L1 rebuy" "BLOCK: ordinary L1 walk"
git checkout -- src/lib/observatory/l1-runner.ts

# 2. BLOCK census (same SQL hook)
sed -i '' '/AND \${notSellerRetestRequestSourceSql()}/d' src/lib/observatory/l1-runner.ts
run_expect_fail "BLOCK census lane" "BLOCK census:"
git checkout -- src/lib/observatory/l1-runner.ts

# 3. BLOCK retest (same SQL hook)
sed -i '' '/AND \${notSellerRetestRequestSourceSql()}/d' src/lib/observatory/l1-runner.ts
run_expect_fail "BLOCK retest lane" "BLOCK retest:"
git checkout -- src/lib/observatory/l1-runner.ts

# 4. L0 tier
sed -i '' 's/AND \${notSellerRetestRequestSourceSql()}//' src/lib/observatory/coverage.ts
run_expect_fail "L0 c1 excludes seller_retest" "L0 c1 tier excludes"
git checkout -- src/lib/observatory/coverage.ts

# 5. Network filter for selectAccept (Arbitrum wall)
sed -i '' 's/a\.network === candidate\.sellerRequest!\.network/a.network !== candidate.sellerRequest!.network/' src/lib/observatory/l1-runner.ts
run_expect_fail "sign on request network (Arbitrum ON)" "Arbitrum lane prefers"
git checkout -- src/lib/observatory/l1-runner.ts

# 6. Network missing accept
sed -i '' 's/a\.network === gate\.network/a.network !== gate.network/' src/lib/observatory/seller-retest.ts
run_expect_fail "network accept missing" "network accept missing"
git checkout -- src/lib/observatory/seller-retest.ts

# 7. Per-run cap
perl -i -pe 's/export const SELLER_RETEST_MAX_PER_RUN = 10;/export const SELLER_RETEST_MAX_PER_RUN = 999;/' src/lib/observatory/seller-retest-requests.ts
run_expect_fail "10 per run cap" "caps at 10 per run"
git checkout -- src/lib/observatory/seller-retest-requests.ts

# 8. Expiry
perl -i -pe 's/return todayUtc <= req\.expiresOn;/return true;/' src/lib/observatory/seller-retest.ts
perl -i -pe 's/export const SELLER_RETEST_MAX_PER_RUN = 10;/export const SELLER_RETEST_MAX_PER_RUN = 999;/' src/lib/observatory/seller-retest-requests.ts
run_expect_fail "expired request not bought" "expired seller request"
git checkout -- src/lib/observatory/seller-retest.ts src/lib/observatory/seller-retest-requests.ts

# 9. One-shot DB guard (partial unique index)
sed -i '' 's/await db.execute(sql.raw(SELLER_INDEX_SQL));/void SELLER_INDEX_SQL;/' "$PG_FILE"
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP INDEX IF EXISTS x402_l1_purchases_seller_request_id_auth_unique"
run_expect_fail "concurrent runL1Batch one payment" "concurrent runL1Batch"
git checkout -- "$PG_FILE"
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-30-seller-retest-request-id-unique.sql

# 10. Once per UTC day retry gate
perl -i -pe 's/if \(attemptedToday\.has\(req\.id\)\) continue;/if (false \&\& attemptedToday.has(req.id)) continue;/' src/lib/observatory/seller-retest.ts
run_expect_fail "no_402 once per day" "no_402 seller request retries"
git checkout -- src/lib/observatory/seller-retest.ts

# 11. ENABLED off variants
perl -i -pe 's/return v === "false" \|\| v === "0" \|\| v === "off" \|\| v === "no";/return v === "false";/' src/lib/observatory/seller-retest-requests.ts
run_expect_fail "OBSERVATORY_SELLER_RETEST_ENABLED=0" 'OBSERVATORY_SELLER_RETEST_ENABLED=0'
git checkout -- src/lib/observatory/seller-retest-requests.ts

# 12. POST body mismatch
perl -i -0pe 's/if \(method === "POST" \&\& candidate\.sellerRequestUnpaid\?\.body\) \{[\s\S]*?\n    \}\n  \}\n\n  const challengeForSelect/if (false) { void 0; }\n\n  const challengeForSelect/s' src/lib/observatory/l1-runner.ts
run_expect_fail "seller request body mismatch" "body mismatch is not signed"
git checkout -- src/lib/observatory/l1-runner.ts

# 13. Public listing counts
perl -i '' 's/AND \${notSellerRetestRequestSourceSql()}//' src/lib/observatory/reader.ts
run_expect_fail "public observatory counts exclude seller_retest" "public observatory counts exclude"
git checkout -- src/lib/observatory/reader.ts

git diff --exit-code
echo "mutation-check-seller-retest: all guards verified"
