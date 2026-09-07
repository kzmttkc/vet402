#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Starting local Postgres..."
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose up -d postgres
  export DATABASE_URL="${DATABASE_URL:-postgresql://vouch:vouch_dev@localhost:5433/vouch}"
  echo "==> Waiting for Docker Postgres..."
  for i in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U vouch -d vouch >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
elif command -v pg_isready >/dev/null 2>&1; then
  if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      brew services start postgresql@16 2>/dev/null || brew services start postgresql 2>/dev/null || true
    fi
    sleep 2
  fi
  export DATABASE_URL="${DATABASE_URL:-postgresql://vouch:vouch_dev@localhost:5432/vouch}"
  psql -h localhost -p 5432 -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='vouch'" | grep -q 1 \
    || psql -h localhost -p 5432 -d postgres -c "CREATE USER vouch WITH PASSWORD 'vouch_dev' CREATEDB;"
  psql -h localhost -p 5432 -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='vouch'" | grep -q 1 \
    || psql -h localhost -p 5432 -d postgres -c "CREATE DATABASE vouch OWNER vouch;"
else
  echo "No Docker Compose or local Postgres found. Set DATABASE_URL and ensure Postgres is running."
  exit 1
fi

echo "==> Pushing schema..."
npm run db:push

echo "==> Done."
# Credentials are never echoed (terminal scrollback and CI logs outlive the session):
# print the URL with the userinfo masked, host and database only.
echo "DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^@/]*@#\1…@#')"
echo ""
echo "Next:"
echo "  npm run dev"
echo "  open http://localhost:3000/signup"
