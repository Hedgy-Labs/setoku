#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Boot (or re-seed) the Setoku sports demo on a box. Idempotent: safe to re-run.
# Run it FROM this directory on the box (e.g. /opt/setoku/demo):
#
#   ./boot.sh                       # bring up + seed (first run generates tokens)
#   DEMO_RESEED=0 ./boot.sh         # bring up without regenerating data
#   DEMO_SEATS_PER_GAME=38000 ./boot.sh   # full-house ticket volume (~3M rows)
#
# It does NOT touch the production stack. Public routing (Caddy) is a separate,
# deliberate step — see caddy-demo.snippet / README.md.
set -euo pipefail
cd "$(dirname "$0")"

EDGE_NETWORK="${DEMO_EDGE_NETWORK:-setoku_default}"
PUBLIC_HOST="${DEMO_PUBLIC_HOST:-demo.51-81-222-176.sslip.io}"
ENV_FILE="${DEMO_ENV_FILE:-.env.demo}"

# Use the edge overlay only if the production network actually exists on this box.
FILES=(-f docker-compose.demo.yml)
if docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
  FILES+=(-f docker-compose.edge.yml)
  echo "→ edge network '$EDGE_NETWORK' found — demo gateway will join it for Caddy."
else
  echo "→ no edge network '$EDGE_NETWORK' — standalone mode (gateway on 127.0.0.1:${DEMO_PORT:-8788} only)."
fi

# First run: generate secrets + tokens.
if [ ! -f "$ENV_FILE" ]; then
  echo "→ first run: generating $ENV_FILE (tokens shown at the end)…"
  umask 077
  cat > "$ENV_FILE" <<EOF
DEMO_PG_PASSWORD=$(openssl rand -hex 12)
DEMO_TOKENS=$(openssl rand -hex 24)=demo@riverside-stags.example
DEMO_CURATOR_TOKENS=$(openssl rand -hex 24)=curator@riverside-stags.example
DEMO_PUBLIC_URL=https://$PUBLIC_HOST
DEMO_EDGE_NETWORK=$EDGE_NETWORK
DEMO_PORT=8788
EOF
fi
set -a; . "$ENV_FILE"; set +a

COMPOSE=(docker compose -p setoku-demo "${FILES[@]}" --env-file "$ENV_FILE")

echo "→ starting demo Postgres…"
"${COMPOSE[@]}" up -d demo-postgres

printf '→ waiting for Postgres health'
for _ in $(seq 1 40); do
  s="$(docker inspect -f '{{.State.Health.Status}}' setoku-demo-demo-postgres-1 2>/dev/null || echo starting)"
  [ "$s" = healthy ] && break
  printf '.'; sleep 2
done
echo " ${s:-?}"

if [ "${DEMO_RESEED:-1}" = "1" ]; then
  echo "→ generating synthetic data (SEATS_PER_GAME=${DEMO_SEATS_PER_GAME:-6000}; this can take a minute)…"
  "${COMPOSE[@]}" run --rm --no-deps \
    -v "$PWD/sports:/app/seed:ro" -w /app \
    -e DATABASE_URL="postgres://postgres:${DEMO_PG_PASSWORD}@demo-postgres.local:5432/stags" \
    -e SEATS_PER_GAME="${DEMO_SEATS_PER_GAME:-6000}" \
    -e SEASON_YEAR="${DEMO_SEASON_YEAR:-2026}" \
    demo-server bun /app/seed/generate.ts
fi

echo "→ starting demo gateway…"
"${COMPOSE[@]}" up -d demo-server
sleep 3

echo "→ local health check:"
curl -fsS "http://127.0.0.1:${DEMO_PORT:-8788}/health" && echo || echo "(gateway not answering yet — check: ${COMPOSE[*]} logs demo-server)"

ANALYST_TOKEN="${DEMO_TOKENS%%=*}"
echo
echo "════════════════════════════════════════════════════════════════════"
echo " Setoku sports demo is up."
echo "   analyst token : ${ANALYST_TOKEN}"
echo "   local URL      : http://127.0.0.1:${DEMO_PORT:-8788}/mcp/${ANALYST_TOKEN}"
echo "   public URL     : ${DEMO_PUBLIC_URL}/mcp/${ANALYST_TOKEN}  (needs Caddy — see caddy-demo.snippet)"
echo "════════════════════════════════════════════════════════════════════"
