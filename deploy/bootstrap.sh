#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# One-command Setoku deploy on a fresh Ubuntu VPS — the "1-click" path.
#
#   git clone <repo> /opt/setoku && cd /opt/setoku && ./deploy/bootstrap.sh
#
# Optional first arg: the public hostname. If omitted, we use
# <public-ip>.sslip.io, which gets a REAL Let's Encrypt cert with zero DNS
# setup (sslip.io resolves any embedded IP). Point a real domain later by
# editing SETOKU_DOMAIN in .env and `docker compose up -d caddy`.
#
# Idempotent: re-running keeps your existing .env and accounts.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/dc.sh # docker compose v2/v1 shim

log() { echo "[bootstrap] $*"; }

# 1. Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null; then
  log "installing Docker…"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
  log "Docker installed. If the next step can't reach the daemon, log out/in once (group change) and re-run."
fi

# 2. Firewall (defense in depth; only Caddy's 80/443 + SSH) -----------------
if command -v ufw >/dev/null; then
  log "firewall: allowing 22/80/443…"
  sudo ufw allow 22/tcp >/dev/null
  sudo ufw allow 80/tcp >/dev/null
  sudo ufw allow 443/tcp >/dev/null
  sudo ufw allow 443/udp >/dev/null
  sudo ufw --force enable >/dev/null
fi

# 3. .env (generated once; secrets randomized) ------------------------------
if [ ! -f .env ]; then
  DOMAIN="${1:-}"
  if [ -z "$DOMAIN" ]; then
    IP="$(curl -fsS4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
    DOMAIN="${IP}.sslip.io"
    log "no domain given → $DOMAIN (sslip.io: real HTTPS, no DNS needed)"
  fi
  gen() { openssl rand -hex 24; }
  umask 077
  cat > .env <<EOF
SETOKU_DOMAIN=$DOMAIN
COMPOSE_PROFILES=lake,ingest
SETOKU_TOKENS=$(gen)=admin@example.com
SETOKU_INGEST_TOKEN=$(gen)
POSTGRES_PASSWORD=$(gen)
CLICKHOUSE_USER=setoku
CLICKHOUSE_PASSWORD=$(gen)
CLICKHOUSE_RO_PASSWORD=$(gen)
SETOKU_CH_PRESET=small
SETOKU_HEALTHZ_PING=vector=http://vector:8686/health
EOF
  log "wrote .env (edit SETOKU_TOKENS identity, and add SETOKU_DATABASE_URL if you want run_query against a business DB)"
else
  log ".env exists — keeping it"
fi
set -a; source .env; set +a

# 4. Bring up the stack -----------------------------------------------------
log "building + starting the stack (first run pulls images — a few minutes)…"
dc up -d --build --wait
log "stack healthy."

# 5. Admin account for the approval surface ---------------------------------
ADMIN_LOGIN_MSG=""
if dc exec -T server bun gateway/admin-cli.ts list-users 2>/dev/null | grep -qE '\S'; then
  log "admin account already exists"
  ADMIN_LOGIN_MSG="login: existing account (reset with: docker compose exec server bun gateway/admin-cli.ts set-password <user>)"
elif [ -n "${SETOKU_ADMIN_USER:-}" ]; then
  # non-interactive path: SETOKU_ADMIN_USER=<name> skips the prompt (good for SSH/automation).
  # A password is REQUIRED — generate one (or take SETOKU_ADMIN_PASSWORD) and print it below.
  ADMIN_PW="${SETOKU_ADMIN_PASSWORD:-$(openssl rand -hex 12)}"
  dc exec -T -e SETOKU_NEW_PASSWORD="$ADMIN_PW" server bun gateway/admin-cli.ts create-user "$SETOKU_ADMIN_USER" --role admin
  log "created admin user '$SETOKU_ADMIN_USER'"
  ADMIN_LOGIN_MSG="login: $SETOKU_ADMIN_USER / $ADMIN_PW   (change it: docker compose exec server bun gateway/admin-cli.ts set-password $SETOKU_ADMIN_USER)"
elif [ -r /dev/tty ]; then
  echo
  log "create your admin login (for https://$SETOKU_DOMAIN/admin):"
  read -rp "  admin username: " ADMINU </dev/tty
  dc exec server bun gateway/admin-cli.ts create-user "${ADMINU:-admin}" --role admin
  ADMIN_LOGIN_MSG="login: ${ADMINU:-admin} / (the password you just set)"
else
  log "no TTY and SETOKU_ADMIN_USER unset — skipping admin account; create one later with:"
  log "  docker compose exec server bun gateway/admin-cli.ts create-user <name> --role admin"
  ADMIN_LOGIN_MSG="no admin account yet — create one: docker compose exec server bun gateway/admin-cli.ts create-user <name> --role admin"
fi

# 6. Report -----------------------------------------------------------------
MCP_TOKEN="$(printf '%s' "$SETOKU_TOKENS" | cut -d= -f1)"
cat <<EOF

===================================================================
 Setoku is live.
   health:           https://$SETOKU_DOMAIN/healthz
   approval surface: https://$SETOKU_DOMAIN/admin
     $ADMIN_LOGIN_MSG
     (this is where you accept proposed knowledge — sign in once now)

 Connect Claude Code:
   claude mcp add --transport http setoku https://$SETOKU_DOMAIN/mcp \\
     --header "Authorization: Bearer $MCP_TOKEN"

 Ingest token (for Vercel/Render drains + app events):
   $SETOKU_INGEST_TOKEN
   POST to https://$SETOKU_DOMAIN/ingest/{vercel,render,events}
===================================================================
EOF
