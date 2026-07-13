#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Deploy the Setoku DEMO (demo.setoku.com — the Bonita Bulldogs instance) to a box.
# The demo runs ALONGSIDE production as its own compose project and reuses the
# gateway image. This script: rsyncs the code, rebuilds that image WITHOUT
# touching the running production gateway, then restarts the demo gateway on the
# fresh image via boot.sh (reseed OFF by default — a code deploy keeps the data).
#
# Box target is read from env or the gitignored deploy/target.local (same as deploy.sh):
#   SETOKU_DEPLOY_SSH   ubuntu@1.2.3.4   (required)
#   SETOKU_DEPLOY_DIR   /opt/setoku      (default)
#
# Demo knobs (passed through to boot.sh — defaults shown):
#   DEMO_RESEED=0       set =1 to regenerate the synthetic data (slow; drops/recreates)
#   DEMO_PUBLIC_HOST    demo.setoku.com  (host for the post-deploy health check)
#   DEMO_DATASET / DEMO_PROJECT / DEMO_ENV_FILE / DEMO_DB / DEMO_PORT  (see demo/boot.sh)
#
# Usage:  bun run deploy:demo
set -euo pipefail
cd "$(dirname "$0")/.."

# load the box target (gitignored) if present
[ -f deploy/target.local ] && . deploy/target.local

SSH="${SETOKU_DEPLOY_SSH:?set SETOKU_DEPLOY_SSH (e.g. ubuntu@1.2.3.4) in env or deploy/target.local}"
DIR="${SETOKU_DEPLOY_DIR:-/opt/setoku}"
PUBLIC_HOST="${DEMO_PUBLIC_HOST:-demo.setoku.com}"

# Forward the demo knobs to boot.sh on the box (defaults: no reseed on a code deploy).
DEMO_ENV="DEMO_RESEED=${DEMO_RESEED:-0}"
for v in DEMO_DATASET DEMO_PROJECT DEMO_ENV_FILE DEMO_DB DEMO_PORT DEMO_PUBLIC_HOST \
         DEMO_SEATS_PER_GAME DEMO_SEASON_YEAR DEMO_GEN_ENV; do
  [ -n "${!v:-}" ] && DEMO_ENV+=" $v=${!v}"
done

# NOTE: we deliberately do NOT rsync Caddyfile — the box copy carries the demo
# routing snippet (demo/caddy-bulldogs.snippet) appended by hand, and the local
# checkout doesn't, so shipping it would silently drop demo routing on the next
# Caddy recreate. Caddy/routing is a separate, deliberate step (see demo/README.md).
echo "→ rsync code to ${SSH}:${DIR}  (dirs WITHOUT trailing slashes)"
rsync -az \
  --exclude='.env' --exclude='.git' --exclude='node_modules' --exclude='seed-mercury-knowledge.ts' \
  plugin deploy demo ingest docker-compose.yml \
  "${SSH}:${DIR}/"

echo "→ rebuild the gateway image (does NOT restart production)"
ssh "$SSH" "cd ${DIR} && docker compose build server"

echo "→ restart the demo gateway on the fresh image (${DEMO_ENV})"
ssh "$SSH" "cd ${DIR}/demo && ${DEMO_ENV} ./boot.sh"

echo "→ verify (give it a moment)…"
sleep 4
printf '   /health: '; curl -s --max-time 12 "https://${PUBLIC_HOST}/health" \
  || echo "(no response yet — check 'docker compose -p setoku-bulldogs logs demo-server')"
echo
echo "✓ demo deployed."
