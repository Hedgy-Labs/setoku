#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Deploy this local checkout to a Setoku box: rsync the gateway code, rebuild the
# `server` container, verify /health. Works for ANY deployment — the box target is
# read from env or a gitignored `deploy/target.local` (never committed, never on the box):
#
#   SETOKU_DEPLOY_SSH      ubuntu@1.2.3.4         (required)
#   SETOKU_DEPLOY_DIR      /opt/setoku            (default)
#   SETOKU_DEPLOY_DOMAIN   setoku.yourco.com      (optional — enables the health check)
#
# Usage:  bun run deploy        (or: bash scripts/deploy.sh)
# For a git-clone box, prefer `git pull && docker compose up -d --build server` instead.
set -euo pipefail
cd "$(dirname "$0")/.."

# load the box target (gitignored) if present
[ -f deploy/target.local ] && . deploy/target.local

SSH="${SETOKU_DEPLOY_SSH:?set SETOKU_DEPLOY_SSH (e.g. ubuntu@1.2.3.4) in env or deploy/target.local}"
DIR="${SETOKU_DEPLOY_DIR:-/opt/setoku}"
DOMAIN="${SETOKU_DEPLOY_DOMAIN:-}"

echo "→ rsync code to ${SSH}:${DIR}  (dirs WITHOUT trailing slashes — a slash flattens them into ${DIR}/)"
rsync -az \
  --exclude='.env' --exclude='.git' --exclude='node_modules' --exclude='seed-mercury-knowledge.ts' \
  plugin deploy ingest docker-compose.yml Caddyfile \
  "${SSH}:${DIR}/"

echo "→ rebuild + restart the gateway"
ssh "$SSH" "cd ${DIR} && docker compose up -d --build server"

if [ -n "$DOMAIN" ]; then
  echo "→ verify (give it a moment)…"
  sleep 4
  printf '   /health: '; curl -s --max-time 12 "https://${DOMAIN}/health" || echo "(no response yet — check 'docker compose logs server')"
  echo
fi

# Live-store knowledge lint (curation-cockpit-spec piece D) — WARN, never gate.
# Runs the canonical SQL in each metric/query doc against the live business DB
# inside the server container and bounds-checks it. A non-zero result is shown
# but does NOT fail the deploy (drift is healed via the cockpit, not by blocking
# a ship). The scheduled canary runs it with --file to file drift as pending
# corrections; here we only warn.
echo "→ knowledge-lint (warn-only)…"
ssh "$SSH" "cd ${DIR} && docker compose exec -T server bun gateway/knowledge-lint.ts" \
  || echo "   (lint reported issues or could not run — review above; deploy NOT blocked)"

echo "✓ deployed."
