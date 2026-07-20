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

# Load the box target (gitignored) if present — as DEFAULTS only. Explicit env
# wins, per the contract in the header ("env or deploy/target.local"): otherwise
# a one-off `SETOKU_DEPLOY_SSH=... bash scripts/deploy.sh` to a second box gets
# silently re-pointed at the canonical box by the sourced file.
_env_ssh="${SETOKU_DEPLOY_SSH:-}"; _env_dir="${SETOKU_DEPLOY_DIR:-}"; _env_domain="${SETOKU_DEPLOY_DOMAIN-__unset__}"
[ -f deploy/target.local ] && . deploy/target.local
[ -n "$_env_ssh" ] && SETOKU_DEPLOY_SSH="$_env_ssh"
[ -n "$_env_dir" ] && SETOKU_DEPLOY_DIR="$_env_dir"
[ "$_env_domain" != "__unset__" ] && SETOKU_DEPLOY_DOMAIN="$_env_domain"

SSH="${SETOKU_DEPLOY_SSH:?set SETOKU_DEPLOY_SSH (e.g. ubuntu@1.2.3.4) in env or deploy/target.local}"
DIR="${SETOKU_DEPLOY_DIR:-/opt/setoku}"
DOMAIN="${SETOKU_DEPLOY_DOMAIN:-}"

echo "→ rsync code to ${SSH}:${DIR}  (dirs WITHOUT trailing slashes — a slash flattens them into ${DIR}/)"
# Hash the bind-mounted configs BEFORE rsync so we can tell what this deploy
# changed — each is inode-pinned, so a rsynced change only reaches the running
# container on a force-recreate (see the per-config blocks after the rsync).
caddy_before="$(ssh "$SSH" "sha256sum ${DIR}/Caddyfile 2>/dev/null | cut -d' ' -f1" || true)"
vector_before="$(ssh "$SSH" "sha256sum ${DIR}/deploy/vector/vector.yaml 2>/dev/null | cut -d' ' -f1" || true)"
chcfg_before="$(ssh "$SSH" "cat ${DIR}/deploy/clickhouse/*.xml 2>/dev/null | sha256sum | cut -d' ' -f1" || true)"
rsync -az \
  --exclude='.env' --exclude='.git' --exclude='node_modules' --exclude='seed-mercury-knowledge.ts' \
  plugin deploy ingest docker-compose.yml Caddyfile \
  "${SSH}:${DIR}/"

echo "→ rebuild + restart the gateway"
ssh "$SSH" "cd ${DIR} && docker compose up -d --build server"

# The Caddyfile is an inode-pinned bind mount (docker-compose.yml), so rsyncing a
# new file (temp + rename = new inode) does NOT reach the running caddy container
# and a reload reads the stale content — caddy must be force-recreated to pick it
# up. Do that ONLY when the file actually changed, since recreating caddy is a
# brief (~1–2s) edge blip we don't want on every deploy. --no-deps so the healthy
# server container is left untouched.
caddy_after="$(ssh "$SSH" "sha256sum ${DIR}/Caddyfile | cut -d' ' -f1")"
if [ "$caddy_before" != "$caddy_after" ]; then
  echo "→ Caddyfile changed — force-recreate caddy (edge, brief blip)"
  ssh "$SSH" "cd ${DIR} && docker compose up -d --force-recreate --no-deps caddy"
fi

# Vector's pipeline config is bind-mounted the same way — a rsynced change (e.g. a
# NEW ingest route) does NOT reach the running vector, so it silently never loads.
# (This bit us: a Gmail source added to the config didn't route until vector was
# recreated by hand.) Force-recreate only when it changed. Vector buffers to disk,
# so the ingest pipeline absorbs the brief restart.
vector_after="$(ssh "$SSH" "sha256sum ${DIR}/deploy/vector/vector.yaml 2>/dev/null | cut -d' ' -f1" || true)"
if [ -n "$vector_after" ] && [ "$vector_before" != "$vector_after" ]; then
  echo "→ Vector config changed — force-recreate vector (loads new ingest routes)"
  ssh "$SSH" "cd ${DIR} && docker compose up -d --force-recreate --no-deps vector"
fi

# ClickHouse users/config XML (lake-users.xml grants+roles, system-logs.xml,
# trace-off.xml) are bind-mounted too — a changed role or log policy needs a
# container recreate to apply (a new source's role otherwise never loads). Only
# on change; recreating clickhouse is a brief (~20s) lake blip. NB: this does NOT
# create new lake TABLES — run scripts/apply-lake-schemas.sh (or apply the new
# ingest/schemas/*.sql) BEFORE the role that grants on them can bind.
chcfg_after="$(ssh "$SSH" "cat ${DIR}/deploy/clickhouse/*.xml 2>/dev/null | sha256sum | cut -d' ' -f1" || true)"
if [ -n "$chcfg_after" ] && [ "$chcfg_before" != "$chcfg_after" ]; then
  echo "→ ClickHouse config changed — force-recreate clickhouse (brief lake blip)"
  ssh "$SSH" "cd ${DIR} && docker compose up -d --force-recreate --no-deps clickhouse"
fi

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
