#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Deploy the static marketing site (site/) to a Setoku box. This is SEPARATE from
# `bun run deploy` (scripts/deploy.sh), which ships the gateway and does NOT touch
# site/. The apex domain is served by a Caddy `file_server` block (see the box's
# caddy.d/setoku-com.caddy: `root * /etc/caddy/conf.d/site; file_server`), so the
# files are just rsynced into a bind-mounted dir and served immediately — no
# container rebuild or reload needed (static content, not config).
#
# The box target is read from env or a gitignored `deploy/target.local` (the box
# IP is kept out of the repo per I3):
#
#   SETOKU_DEPLOY_SSH     ubuntu@1.2.3.4              (required)
#   SETOKU_SITE_DIR       /opt/setoku/caddy.d/site    (default — the file_server root)
#   SETOKU_SITE_DOMAIN    setoku.com                  (default — used for the verify curl)
#
# Usage:  bun run deploy:site   (or: bash scripts/deploy-site.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f deploy/target.local ] && . deploy/target.local

SSH="${SETOKU_DEPLOY_SSH:?set SETOKU_DEPLOY_SSH (e.g. ubuntu@1.2.3.4) in env or deploy/target.local}"
SITE_DIR="${SETOKU_SITE_DIR:-/opt/setoku/caddy.d/site}"
DOMAIN="${SETOKU_SITE_DOMAIN:-setoku.com}"

echo "→ rsync site/ to ${SSH}:${SITE_DIR}"
rsync -az --exclude='.DS_Store' site/index.html site/assets "${SSH}:${SITE_DIR}/"

echo "→ verify https://${DOMAIN}/ …"
printf '   title: '
curl -s --max-time 12 "https://${DOMAIN}/" | grep -o '<title>[^<]*</title>' \
  || echo "(no response / no title — check that ${DOMAIN} points at the box)"

echo "✓ site deployed."
