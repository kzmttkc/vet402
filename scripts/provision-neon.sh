#!/usr/bin/env bash
set -euo pipefail

# Creates Neon project + database and prints pooled DATABASE_URL.
# Requires: npx neonctl (authenticated via `npx neonctl auth`)

PROJECT_NAME="${NEON_PROJECT_NAME:-vouch-agent-trust}"
DB_NAME="${NEON_DATABASE_NAME:-vouch}"
ORG_ID="${NEON_ORG_ID:-}"

echo "==> Creating Neon project: $PROJECT_NAME"
CREATE_ARGS=(--name "$PROJECT_NAME" --output json)
if [[ -n "$ORG_ID" ]]; then
  CREATE_ARGS+=(--org-id "$ORG_ID")
fi

PROJECT_ID=$(npx neonctl projects create "${CREATE_ARGS[@]}" | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")

echo "==> Creating database: $DB_NAME"
npx neonctl databases create --project-id "$PROJECT_ID" --name "$DB_NAME" >/dev/null || true

echo "==> Fetching pooled connection string"
DATABASE_URL=$(npx neonctl connection-string main --project-id "$PROJECT_ID" --database-name "$DB_NAME" --pooled)

# The connection string carries the role password. Print it masked (host and database
# only) so it never lands in terminal scrollback or CI logs; the full pooled URL is one
# command away and should go straight into an env file, not into a chat or a log.
echo "DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^@/]*@#\1…@#')"
echo "NEON_PROJECT_ID=$PROJECT_ID"
echo "Full connection string (credentials included — keep it out of logs):"
echo "  npx neonctl connection-string main --project-id $PROJECT_ID --database-name $DB_NAME --pooled"
