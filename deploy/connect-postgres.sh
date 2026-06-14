#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Collapse the Postgres connect chore-chain into one verified command.
# Given an admin/owner connection URL to your business DB, this:
#   1. creates (or updates) a least-privilege read-only role `setoku_ro`,
#   2. verifies it can actually SELECT and is forced read-only,
#   3. prints the SETOKU_DATABASE_URL line to set on the box
#      (and writes it for you with --env-file).
#
# Setoku never runs DDL — YOU run this, once, against the DB you choose.
# Prefer a dev/staging DB; only point at prod if you mean to.
#
# Usage:
#   deploy/connect-postgres.sh 'postgresql://admin:pass@host:5432/mydb'
#   deploy/connect-postgres.sh 'postgresql://admin:pass@host:5432/mydb' --env-file /opt/setoku/.env
#   ADMIN_URL='postgresql://...' deploy/connect-postgres.sh        # URL via env, keeps it out of shell history
#
# Requires: psql on PATH.
set -euo pipefail

ADMIN_URL="${1:-${ADMIN_URL:-}}"
ENV_FILE=""
ROLE="setoku_ro"
case "${1:-}" in postgresql://*|postgres://*) shift || true ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --role) ROLE="${2:?--role needs a name}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ADMIN_URL" ]; then
  echo "usage: $0 'postgresql://admin:pass@host:5432/db' [--env-file PATH] [--role NAME]" >&2
  echo "   (or set ADMIN_URL in the environment to keep the secret out of shell history)" >&2
  exit 2
fi
command -v psql >/dev/null || {
  echo "error: psql not found on PATH. Install the Postgres client, then re-run:" >&2
  echo "  Ubuntu/Debian:  sudo apt-get update && sudo apt-get install -y postgresql-client" >&2
  echo "  macOS:          brew install libpq && brew link --force libpq" >&2
  exit 1
}

# Derive host/port/db from the admin URL by replacing only the userinfo — robust
# to admin passwords containing '@', ':' etc. (we never parse the admin password).
after_at="${ADMIN_URL##*@}"            # host:port/db?params
hostpath="${after_at}"
dbpart="${hostpath#*/}"                 # db?params  (empty if no /db)
DB="${dbpart%%\?*}"                     # db
[ -n "$DB" ] && [ "$DB" != "$hostpath" ] || { echo "error: couldn't find a database name in the URL (need .../<db>)" >&2; exit 1; }

PW="$(openssl rand -hex 24)"
RO_URL="postgresql://${ROLE}:${PW}@${after_at}"

echo "→ creating/updating read-only role '${ROLE}' on database '${DB}' ..."
PGOPTIONS='--client-min-messages=warning' psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -v role="$ROLE" -v pw="$PW" -v db="$DB" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
GRANT CONNECT ON DATABASE :"db" TO :"role";
GRANT USAGE ON SCHEMA public TO :"role";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :"role";
ALTER ROLE :"role" SET default_transaction_read_only = on;
ALTER ROLE :"role" SET statement_timeout = '20s';
SQL

echo "→ verifying the role can read and is read-only ..."
psql "$RO_URL" -v ON_ERROR_STOP=1 -tAc 'SELECT 1' >/dev/null
# A write must be refused — prove the read-only posture rather than trust it.
if psql "$RO_URL" -tAc 'CREATE TEMP TABLE _setoku_probe(x int)' >/dev/null 2>&1; then
  echo "  ! warning: the role was able to create a temp table — default_transaction_read_only may not be applied. Continuing, but check your grants." >&2
else
  echo "  ✓ writes refused; SELECT works."
fi

LINE="SETOKU_DATABASE_URL=${RO_URL}"
if [ -n "$ENV_FILE" ]; then
  touch "$ENV_FILE"
  # replace an existing line or append
  if grep -q '^SETOKU_DATABASE_URL=' "$ENV_FILE"; then
    tmp="$(mktemp)"; grep -v '^SETOKU_DATABASE_URL=' "$ENV_FILE" > "$tmp"; printf '%s\n' "$LINE" >> "$tmp"; mv "$tmp" "$ENV_FILE"
  else
    printf '%s\n' "$LINE" >> "$ENV_FILE"
  fi
  echo "→ wrote SETOKU_DATABASE_URL to $ENV_FILE — restart the gateway:  docker compose up -d server"
else
  echo
  echo "Set this on the box (then restart:  docker compose up -d server):"
  echo
  echo "  $LINE"
fi
echo
echo "Next: set the table allow-list in the repo's .setoku/config.json, then verify with get_schema."
