#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Boot (or re-seed) the Setoku demo on a box. Idempotent: safe to re-run.
# Defaults to the Bonita Bulldogs multi-system dataset (the only demo).
#
#   ./boot.sh                       # the Bulldogs demo
#
# Parameterize a different dataset/instance with env vars (defaults shown):
#   DEMO_DATASET       dir under demo/ holding .setoku + schema.sql + generate.ts   (bulldogs)
#   DEMO_PROJECT       docker compose project name (isolates containers/volumes)    (setoku-bulldogs)
#   DEMO_ENV_FILE      secrets/token file                                           (.env.bulldogs)
#   DEMO_DB            Postgres database name                                        (bulldogs)
#   DEMO_PORT          localhost port for the gateway                               (8789)
#   DEMO_PUBLIC_HOST   hostname Caddy will front it on                              (demo.setoku.com)
#   DEMO_RESEED=0      skip data regeneration
#   DEMO_SEATS_PER_GAME / DEMO_SEASON_YEAR / DEMO_GEN_ENV  extra generator knobs
#
# It does NOT touch the production stack. Public routing (Caddy) is separate.
set -euo pipefail
cd "$(dirname "$0")"

DATASET="${DEMO_DATASET:-bulldogs}"
PROJECT="${DEMO_PROJECT:-setoku-bulldogs}"
ENV_FILE="${DEMO_ENV_FILE:-.env.bulldogs}"
DB="${DEMO_DB:-bulldogs}"
PORT="${DEMO_PORT:-8789}"
PUBLIC_HOST="${DEMO_PUBLIC_HOST:-demo.setoku.com}"
EDGE_NETWORK="${DEMO_EDGE_NETWORK:-setoku_default}"
PG_C="${PROJECT}-demo-postgres-1"

[ -d "$DATASET/.setoku" ] || { echo "no dataset at $DATASET/.setoku" >&2; exit 1; }

FILES=(-f docker-compose.demo.yml)
if docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
  FILES+=(-f docker-compose.edge.yml)
  echo "→ edge network '$EDGE_NETWORK' found — gateway will join it for Caddy."
else
  echo "→ no edge network — standalone mode (gateway on 127.0.0.1:${PORT} only)."
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "→ first run: generating $ENV_FILE …"
  umask 077
  cat > "$ENV_FILE" <<EOF
DEMO_PG_PASSWORD=$(openssl rand -hex 12)
DEMO_TOKENS=$(openssl rand -hex 24)=demo@bonita-bulldogs.example
DEMO_CURATOR_TOKENS=$(openssl rand -hex 24)=curator@bonita-bulldogs.example
DEMO_PUBLIC_URL=https://$PUBLIC_HOST
DEMO_EDGE_NETWORK=$EDGE_NETWORK
DEMO_DATASET_DIR=./$DATASET
DEMO_DB=$DB
DEMO_PORT=$PORT
EOF
fi
set -a; . "$ENV_FILE"; set +a
# keep env-file in sync with any overrides passed this run
export DEMO_DATASET_DIR="./$DATASET" DEMO_DB="$DB" DEMO_PORT="$PORT"

COMPOSE=(docker compose -p "$PROJECT" "${FILES[@]}" --env-file "$ENV_FILE")

echo "→ starting Postgres ($PG_C, db=$DB) …"
"${COMPOSE[@]}" up -d demo-postgres

printf '→ waiting for Postgres health'
for _ in $(seq 1 40); do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$PG_C" 2>/dev/null || echo starting)"
  [ "$s" = healthy ] && break; printf '.'; sleep 2
done; echo " ${s:-?}"

if [ "${DEMO_RESEED:-1}" = "1" ]; then
  echo "→ generating synthetic data for '$DATASET' (this can take a few minutes) …"
  # Only pass generator knobs that are actually set — an empty -e VAR= becomes
  # Number("") = 0 in the generator and would produce no rows.
  GEN_ENV=()
  [ -n "${DEMO_SEATS_PER_GAME:-}" ] && GEN_ENV+=(-e "SEATS_PER_GAME=$DEMO_SEATS_PER_GAME")
  [ -n "${DEMO_SEASON_YEAR:-}" ]    && GEN_ENV+=(-e "SEASON_YEAR=$DEMO_SEASON_YEAR")
  if [ -n "${DEMO_GEN_ENV:-}" ]; then for kv in $DEMO_GEN_ENV; do GEN_ENV+=(-e "$kv"); done; fi
  "${COMPOSE[@]}" run --rm --no-deps \
    -v "$PWD/$DATASET:/app/seed:ro" -w /app \
    -e DATABASE_URL="postgres://postgres:${DEMO_PG_PASSWORD}@demo-postgres.local:5432/${DB}" \
    ${GEN_ENV[@]+"${GEN_ENV[@]}"} \
    demo-server bun /app/seed/generate.ts
fi

echo "→ starting lake + business-DB mirror …"
"${COMPOSE[@]}" up -d --build demo-clickhouse demo-pg-mirror
# a reseed replaced the source data — bounce the mirror so it reloads NOW
# instead of serving the previous dataset for up to a full cron interval
if [ "${DEMO_RESEED:-1}" = "1" ]; then
  "${COMPOSE[@]}" restart demo-pg-mirror
fi

echo "→ starting gateway …"
"${COMPOSE[@]}" up -d demo-server
sleep 3

echo "→ local health check:"
curl -fsS "http://127.0.0.1:${PORT}/health" && echo || echo "(not answering yet — ${COMPOSE[*]} logs demo-server)"

ANALYST_TOKEN="${DEMO_TOKENS%%=*}"
echo
echo "════════════════════════════════════════════════════════════════════"
echo " Setoku demo '$DATASET' up  (project $PROJECT, db $DB)"
echo "   analyst token : ${ANALYST_TOKEN}"
echo "   local URL      : http://127.0.0.1:${PORT}/mcp/${ANALYST_TOKEN}"
echo "   public URL     : ${DEMO_PUBLIC_URL}/mcp/${ANALYST_TOKEN}  (needs Caddy)"
echo "════════════════════════════════════════════════════════════════════"
