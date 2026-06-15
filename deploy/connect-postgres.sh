#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Collapse the Postgres connect chore-chain into one verified command.
# Given an admin/owner connection URL to your business DB, this:
#   1. creates (or updates) a least-privilege read-only role `setoku_ro`,
#   2. verifies it can SELECT and that writes are refused,
#   3. prints the SETOKU_DATABASE_URL line to set on the box
#      (and writes it for you with --env-file).
#
# Setoku never runs DDL — YOU run this, once, against the DB you choose.
#
# SAFETY: prefers a LOCAL/dev DB. A remote host (e.g. Supabase, RDS) needs an
# explicit --allow-remote (or a y/N confirm) because every later query then reads
# LIVE data into Claude + the audit log. Connection POOLERS (pgbouncer / port
# 6543 / `pgbouncer=true` / *.pooler.*) are refused: role DDL and the read-only
# session setting don't work reliably through transaction pooling — use the
# DIRECT / non-pooling URL (e.g. POSTGRES_URL_NON_POOLING, db.<ref>.supabase.co).
#
# Usage (prefer the env form — keeps the admin password out of shell history):
#   ADMIN_URL='postgresql://owner:pass@localhost:5432/mydb' deploy/connect-postgres.sh --env-file /opt/setoku/.env
#   ADMIN_URL='...' deploy/connect-postgres.sh                       # just print the line
#   deploy/connect-postgres.sh 'postgresql://owner:pass@host/db'     # positional (password lands in history)
# Flags: --env-file PATH  --role NAME  --allow-remote  --rotate
#   --rotate forces a new password (breaks a running gateway until it's updated).
#   Without it, re-running an existing role REUSES its password (via --env-file)
#   so you can safely re-run without knocking the gateway offline.
#
# Requires: psql on PATH.
set -euo pipefail

ADMIN_URL="${ADMIN_URL:-}"
ENV_FILE=""
ROLE="setoku_ro"
ALLOW_REMOTE=0
ROTATE=0
# A positional URL (if given) wins over the env var; flags are parsed after.
case "${1:-}" in postgresql://*|postgres://*) ADMIN_URL="$1"; shift ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --role) ROLE="${2:?--role needs a name}"; shift 2 ;;
    --allow-remote) ALLOW_REMOTE=1; shift ;;
    --rotate) ROTATE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ADMIN_URL" ]; then
  echo "usage: ADMIN_URL='postgresql://owner:pass@localhost:5432/db' $0 [--env-file PATH] [--role NAME] [--allow-remote] [--rotate]" >&2
  echo "   (set ADMIN_URL in the environment to keep the secret out of shell history)" >&2
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
dbpart="${after_at#*/}"                 # db?params  (empty if no /db)
DB="${dbpart%%\?*}"                     # db
[ -n "$DB" ] && [ "$DB" != "$after_at" ] || { echo "error: couldn't find a database name in the URL (need .../<db>)" >&2; exit 1; }
HOST="${after_at%%[:/]*}"              # host (strip :port or /db)

# --- safety: refuse poolers, gate remote hosts ----------------------------
lc="$(printf '%s' "$ADMIN_URL" | tr '[:upper:]' '[:lower:]')"
case "$lc" in
  *pgbouncer=true*|*pooler.*|*:6543/*)
    echo "error: this looks like a connection POOLER (host '$HOST')." >&2
    echo "  Role creation + the read-only session setting don't work reliably through a" >&2
    echo "  transaction pooler. Use the DIRECT / non-pooling URL for this step —" >&2
    echo "  e.g. POSTGRES_URL_NON_POOLING, or Supabase's db.<ref>.supabase.co:5432." >&2
    exit 2 ;;
esac
case "$HOST" in
  localhost|127.0.0.1|::1|""|/*) : ;;  # local / unix socket — fine
  *)
    if [ "$ALLOW_REMOTE" != "1" ]; then
      echo "⚠ REMOTE database: host '$HOST', db '$DB'." >&2
      echo "  Setoku will read LIVE data from this DB into every query and the audit log." >&2
      echo "  Strongly prefer a local/dev DB. Production read-only is still a data-exposure path." >&2
      if [ -r /dev/tty ]; then
        printf "  Proceed against this remote DB anyway? [y/N] " >&2
        read -r ans </dev/tty || ans=""
        case "$ans" in y|Y|yes|YES) : ;; *) echo "  aborted." >&2; exit 2 ;; esac
      else
        echo "  Re-run with --allow-remote to proceed non-interactively." >&2
        exit 2
      fi
    fi ;;
esac

# --- password: reuse on re-run unless --rotate (don't knock a live gateway) -
role_exists="$(psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'" 2>/dev/null | tr -d '[:space:]')"
existing_pw=""
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  line="$(grep -m1 '^SETOKU_DATABASE_URL=' "$ENV_FILE" || true)"
  url="${line#SETOKU_DATABASE_URL=}"
  case "$url" in *"://${ROLE}:"*) rest="${url#*://${ROLE}:}"; existing_pw="${rest%%@*}" ;; esac
fi

SET_PW=1
if [ "$role_exists" = "1" ] && [ "$ROTATE" != "1" ]; then
  if [ -n "$existing_pw" ]; then
    PW="$existing_pw"; SET_PW=0
    echo "→ role '${ROLE}' exists; reusing its current password (no rotation — a running gateway keeps working)."
  else
    echo "error: role '${ROLE}' already exists and its password isn't known here." >&2
    echo "  Re-running would have to ROTATE the password, which breaks a running gateway." >&2
    echo "   • pass --env-file <the box's .env> to reuse the existing password, or" >&2
    echo "   • pass --rotate to intentionally rotate (then update SETOKU_DATABASE_URL + restart)." >&2
    exit 2
  fi
else
  PW="$(openssl rand -hex 24)"
  [ "$role_exists" = "1" ] && echo "→ --rotate: minting a NEW password (update the gateway's SETOKU_DATABASE_URL + restart after)."
fi

RO_URL="postgresql://${ROLE}:${PW}@${after_at}"   # keeps sslmode etc. from the admin URL

echo "→ creating/updating read-only role '${ROLE}' on database '${DB}' (host '${HOST}') ..."
PGOPTIONS='--client-min-messages=warning' psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -v role="$ROLE" -v pw="$PW" -v db="$DB" -v set_pw="$SET_PW" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') AND :set_pw = 1 \gexec
GRANT CONNECT ON DATABASE :"db" TO :"role";
GRANT USAGE ON SCHEMA public TO :"role";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :"role";
ALTER ROLE :"role" SET default_transaction_read_only = on;
ALTER ROLE :"role" SET statement_timeout = '20s';
SQL

echo "→ verifying ... (read-only is enforced primarily by the SELECT-only GRANT; the"
echo "   read-only session setting is defense-in-depth)"
psql "$RO_URL" -v ON_ERROR_STOP=1 -tAc 'SELECT 1' >/dev/null
# Fresh connection each psql call — a write must be refused.
if psql "$RO_URL" -tAc 'CREATE TEMP TABLE _setoku_probe(x int)' >/dev/null 2>&1; then
  echo "  ! warning: the role created a temp table — it is NOT fully read-only. Check that no" >&2
  echo "    write privileges were granted, and that you're not connected via a pooler." >&2
else
  echo "  ✓ writes refused; SELECT works."
fi

LINE="SETOKU_DATABASE_URL=${RO_URL}"
if [ -n "$ENV_FILE" ]; then
  touch "$ENV_FILE"
  if grep -q '^SETOKU_DATABASE_URL=' "$ENV_FILE"; then
    # `grep -v` exits 1 when it removes the only line — tolerate it under set -e
    tmp="$(mktemp)"; { grep -v '^SETOKU_DATABASE_URL=' "$ENV_FILE" || true; } > "$tmp"; printf '%s\n' "$LINE" >> "$tmp"; mv "$tmp" "$ENV_FILE"
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
