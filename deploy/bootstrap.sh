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
  # No SETOKU_TOKENS here: agent connectors are provisioned in the gateway's DB
  # (step 5 creates the operator's), so they're rotatable/revocable at runtime.
  cat > .env <<EOF
SETOKU_DOMAIN=$DOMAIN
COMPOSE_PROFILES=lake,ingest
SETOKU_INGEST_TOKEN=$(gen)
POSTGRES_PASSWORD=$(gen)
CLICKHOUSE_USER=setoku
CLICKHOUSE_PASSWORD=$(gen)
CLICKHOUSE_RO_PASSWORD=$(gen)
SETOKU_CH_PRESET=small
SETOKU_HEALTHZ_PING=vector=http://vector:8686/health
EOF
  # Second isolated stack on the same box (testing): persist the stack name and
  # alternate edge ports so every later `docker compose` here stays isolated and
  # doesn't fight the production stack for ports 80/443.
  if [ -n "${SETOKU_STACK:-}" ] && [ "$SETOKU_STACK" != "setoku" ]; then
    {
      echo "SETOKU_STACK=$SETOKU_STACK"
      echo "SETOKU_EDGE_HTTP_PORT=${SETOKU_EDGE_HTTP_PORT:-8080}"
      echo "SETOKU_EDGE_HTTPS_PORT=${SETOKU_EDGE_HTTPS_PORT:-8443}"
    } >> .env
    log "isolated stack '$SETOKU_STACK' on edge ports ${SETOKU_EDGE_HTTP_PORT:-8080}/${SETOKU_EDGE_HTTPS_PORT:-8443} (separate containers + volumes)"
  fi
  log "wrote .env (add SETOKU_DATABASE_URL if you want run_query against a business DB)"
else
  log ".env exists — keeping it"
fi
set -a; source .env; set +a

# 4. Bring up the stack -----------------------------------------------------
# Prefer the prebuilt gateway image (published by CI) — the box PULLS instead of
# running bun install + baking the embed model on a small VPS. Fall back to an
# on-box build only if the image can't be pulled (private/unpublished tag, air-gap).
log "starting the stack (first run pulls images — a few minutes)…"
if dc pull --quiet server 2>/dev/null; then
  log "using prebuilt gateway image (no on-box compile)"
  dc up -d --wait
else
  log "prebuilt gateway image unavailable — building on the box (slower)…"
  dc up -d --build --wait
fi
log "stack healthy."

# 5. The operator: ONE person = your /admin login AND your agent connector ---
# (same identity for both — users and connectors are 1:1)
ADMIN_LOGIN_MSG=""
MCP_TOKEN=""
OPERATOR=""
if dc exec -T server bun gateway/admin-cli.ts list-users 2>/dev/null | grep -qE '\S'; then
  log "operator already exists — keeping accounts"
  ADMIN_LOGIN_MSG="login: existing account (reset with: docker compose exec server bun gateway/admin-cli.ts set-password <user>)"
else
  if [ -n "${SETOKU_ADMIN_USER:-}" ]; then
    # non-interactive path: SETOKU_ADMIN_USER=<email> skips the prompt (SSH/automation).
    OPERATOR="$SETOKU_ADMIN_USER"
  elif [ -r /dev/tty ]; then
    echo
    log "create the operator (this ONE identity is both your /admin login and your agent connector):"
    read -rp "  your email (login + connector identity) [admin]: " OPERATOR </dev/tty
    OPERATOR="${OPERATOR:-admin}"
  else
    log "no TTY and SETOKU_ADMIN_USER unset — skipping the operator; create one later with:"
    log "  docker compose exec server bun gateway/admin-cli.ts add-person <email> --role admin"
    ADMIN_LOGIN_MSG="no operator yet — create one: docker compose exec server bun gateway/admin-cli.ts add-person <email> --role admin"
  fi
  if [ -n "$OPERATOR" ]; then
    # The password is generated (SETOKU_ADMIN_PASSWORD overrides) because the
    # add-person output is captured below — an interactive prompt inside $( )
    # would hang invisibly. It's printed once in the report; change it after.
    ADMIN_PW="${SETOKU_ADMIN_PASSWORD:-$(openssl rand -hex 12)}"
    OUT="$(dc exec -T -e SETOKU_NEW_PASSWORD="$ADMIN_PW" server bun gateway/admin-cli.ts add-person "$OPERATOR" --role admin)"
    # add-person's output contract: exactly one `token=<48 hex>` line.
    MCP_TOKEN="$(printf '%s\n' "$OUT" | sed -n 's/^token=//p' | head -n1)"
    log "created operator '$OPERATOR' (login + agent connector)"
    ADMIN_LOGIN_MSG="login: $OPERATOR / $ADMIN_PW   (change it: docker compose exec server bun gateway/admin-cli.ts set-password $OPERATOR)"
  fi
fi

# 6. Report -----------------------------------------------------------------
# Legacy fallback: an old .env may still carry env-pinned SETOKU_TOKENS.
[ -z "$MCP_TOKEN" ] && MCP_TOKEN="$(printf '%s' "${SETOKU_TOKENS:-}" | cut -d= -f1)"
# Give this box a distinct connector name so a second box (a demo, another
# deployment) doesn't collide with a bare `setoku` connector. Defaults to the
# operator's name (the part before @ for an email); /onboard confirms/renames
# it (writes `name` to config.json).
NAME_BASE="${SETOKU_NAME:-${OPERATOR%%@*}}"
NAME_SLUG="$(printf '%s' "$NAME_BASE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//')"
if [ -n "$NAME_SLUG" ]; then CONNECTOR="${NAME_SLUG}-setoku"; else CONNECTOR="setoku"; fi
if [ -n "$MCP_TOKEN" ]; then
  CONNECT_MSG=" Connect Claude Code (/onboard can rename this to your company — <name>-setoku):
   claude mcp add --transport http $CONNECTOR https://$SETOKU_DOMAIN/mcp \\
     --header \"Authorization: Bearer $MCP_TOKEN\""
else
  CONNECT_MSG=" Mint an agent connector (none was created this run):
   docker compose exec server bun gateway/admin-cli.ts add-person <email>
   (or sign in at https://$SETOKU_DOMAIN/admin → Team → Invite)"
fi
cat <<EOF

===================================================================
 Setoku is live.
   health:           https://$SETOKU_DOMAIN/healthz
   approval surface: https://$SETOKU_DOMAIN/admin
     $ADMIN_LOGIN_MSG
     (this is where you accept proposed knowledge — sign in once now)

$CONNECT_MSG

 Ingest token (for Vercel/Render drains + app events):
   $SETOKU_INGEST_TOKEN
   POST to https://$SETOKU_DOMAIN/ingest/{vercel,render,events}
===================================================================
EOF
