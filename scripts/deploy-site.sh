#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Deploy the static marketing site (site/) to a Setoku box. This is SEPARATE from
# `bun run deploy` (scripts/deploy.sh), which ships the gateway and does NOT touch
# site/. The apex domain is served by a Caddy `file_server` block — the canonical
# copy is deploy/caddy.d/setoku-com.caddy, installed on the box at
# /opt/setoku/caddy.d/ — so the files are just rsynced into a bind-mounted dir
# and served immediately: no container rebuild or reload needed (static content,
# not config). Changing the Caddy block itself DOES need a caddy force-recreate;
# see the comments in that file.
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

# Regenerate the machine-readable files first so a deploy can never ship an
# openapi.json / tools.json that lags the source tree.
echo "→ rebuild site API artifacts"
bun scripts/build-site-api.ts

# Whole directory, so new documents (llms.txt, robots.txt, sitemap.xml,
# openapi.json, api/, developers/) ship without editing this list every time.
echo "→ rsync site/ to ${SSH}:${SITE_DIR}"
rsync -az --delete --exclude='.DS_Store' site/ "${SSH}:${SITE_DIR}/"

echo "→ verify https://${DOMAIN}/ …"
printf '   title: '
curl -s --max-time 12 "https://${DOMAIN}/" | grep -o '<title>[^<]*</title>' \
  || echo "(no response / no title — check that ${DOMAIN} points at the box)"

# The agent-facing surface: each must return its own content type, and an
# unknown path must 404 rather than falling back to the homepage. A 200 here for
# /nonsense-404-probe means the box still has the old `try_files … /index.html`
# block — install deploy/caddy.d/setoku-com.caddy and force-recreate caddy.
echo "→ verify the agent-facing surface …"
for p in /llms.txt /robots.txt /sitemap.xml /openapi.json /api/index.json \
         /api/tools.json /api/connectors.json /developers /nonsense-404-probe; do
  read -r code type < <(curl -s -o /dev/null --max-time 12 \
    -w '%{http_code} %{content_type}\n' "https://${DOMAIN}${p}")
  want=200; [ "$p" = /nonsense-404-probe ] && want=404
  mark=" "; [ "$code" = "$want" ] || mark="!"
  printf '   %s %-24s %s  %s\n' "$mark" "$p" "$code" "$type"
done

echo "✓ site deployed."
