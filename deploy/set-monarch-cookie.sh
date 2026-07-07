#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Store a Monarch browser session (session_id + csrftoken cookies) into a Setoku
# .env for cookie-auth polling. Monarch blocks automated password logins, so the
# working auth is a session lifted from a logged-in browser. Values are read
# hidden and only the two cookies are persisted — nothing else.
#
# Usage:  set-monarch-cookie.sh [--env-file /opt/setoku/.env]
set -euo pipefail

ENV_FILE="/opt/setoku/.env"
case "${1:-}" in
  --env-file) ENV_FILE="${2:?}" ;;
  "" ) : ;;
  * ) ENV_FILE="$1" ;;
esac

printf 'Paste Monarch session_id cookie value (hidden): ' >&2; read -rs SID < /dev/tty; echo >&2
printf 'Paste Monarch csrftoken cookie value (hidden): ' >&2; read -rs CSRF < /dev/tty; echo >&2
SID="${SID// /}"; CSRF="${CSRF// /}"
[ -n "$SID" ] && [ -n "$CSRF" ] || { echo "set-monarch-cookie: both values are required" >&2; exit 1; }

touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
tmp="$(mktemp)"
grep -vE '^(SETOKU_MONARCH_SESSION_ID|SETOKU_MONARCH_CSRFTOKEN)=' "$ENV_FILE" > "$tmp" 2>/dev/null || true
cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
printf 'SETOKU_MONARCH_SESSION_ID=%s\n' "$SID" >> "$ENV_FILE"
printf 'SETOKU_MONARCH_CSRFTOKEN=%s\n' "$CSRF" >> "$ENV_FILE"
echo "set-monarch-cookie: stored session_id + csrftoken in $ENV_FILE" >&2
