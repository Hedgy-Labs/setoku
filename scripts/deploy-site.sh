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
# openapi.json, api/, docs/) ship without editing this list every time.
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
surface_bad=0
for p in /llms.txt /robots.txt /sitemap.xml /openapi.json /api/index.json \
         /api/tools.json /api/connectors.json /docs \
         /.well-known/mcp.json /.well-known/agent-card.json \
         /.well-known/agent-skills/index.json /nonsense-404-probe; do
  read -r code type < <(curl -s -o /dev/null --max-time 12 \
    -w '%{http_code} %{content_type}\n' "https://${DOMAIN}${p}")
  want=200; [ "$p" = /nonsense-404-probe ] && want=404
  mark=" "; if [ "$code" != "$want" ]; then mark="!"; surface_bad=$((surface_bad + 1)); fi
  printf '   %s %-38s %s  %s\n' "$mark" "$p" "$code" "$type"
done

# The parts of the surface that depend on the CADDY BLOCK, not just on a file
# being rsynced: markdown content type, ?mode=agent, and JSON errors. These are
# the ones that silently regress, because the file is right there on disk and
# only the header is wrong — and a client deciding whether we serve markdown
# looks at the header. A mismatch here means the box is running an older
# deploy/caddy.d/setoku-com.caddy: run `bun run deploy` to install and reload it.
for probe in "/index.md|200|text/markdown|" "/docs.md|200|text/markdown|" \
             "/?mode=agent|200|text/markdown|" "/docs?mode=agent|200|text/markdown|" \
             "/api/nonsense-404-probe.json|404|application/json|" \
             "/nonsense-404-probe|404|text/html|text/html"; do
  # The last field is an Accept header. Plain curl sends `*/*`, which always
  # lands in the JSON branch of handle_errors — so without it, the branded HTML
  # 404 was never exercised and a missing 404.html shipped green.
  IFS='|' read -r p want_code want_type accept <<<"$probe"
  read -r code type < <(curl -s -o /dev/null --max-time 12 \
    ${accept:+-H "Accept: ${accept}"} \
    -w '%{http_code} %{content_type}\n' "https://${DOMAIN}${p}")
  mark=" "
  case "$code:$type" in
    "$want_code":"$want_type"*) ;;
    *) mark="!"; surface_bad=$((surface_bad + 1)) ;;
  esac
  printf '   %s %-38s %s  %s\n' "$mark" "$p" "$code" "$type"
done
if [ "$surface_bad" -ne 0 ]; then
  echo
  echo "   ✗ ${surface_bad} path(s) wrong — the published surface is NOT correct."
  echo "     A 200 for /nonsense-404-probe means the box still has the old"
  echo "     \`try_files … /index.html\` fallback, so every agent probing"
  echo "     /openapi.json gets HTML. Install deploy/caddy.d/setoku-com.caddy"
  echo "     (\`bun run deploy\` now ships and reloads it), then re-run."
  exit 1
fi

# The demo links we advertise live on a DIFFERENT box, so they can rot without
# anything in this repo changing — that is how the previously published token went
# dead while every page kept serving it. Probe them for real.
#
# These WARN rather than exit non-zero, deliberately: the demo box being down (or
# unreachable from here) says nothing about whether setoku.com deployed correctly,
# and blocking a marketing-copy fix on an unrelated box's health trades a small
# problem for a bigger one. A dead credential and a rebooting box also look
# identical from here, so a hard failure would send you to rotate a token that was
# never broken. The surface check above is the one that gates the deploy.
echo "→ check the demo links we advertise (warn-only — different box) …"
demo_warn=0
DEMO_URL=$(bun -e 'import { DEMO_MCP_URL } from "./demo/connector"; console.log(DEMO_MCP_URL)')
demo_probe=$(curl -s --max-time 20 -X POST "$DEMO_URL" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-verify","version":"0"}}}' || true)
if printf '%s' "$demo_probe" | grep -q '"serverInfo"'; then
  echo "   ✓ demo connector authenticates ($(printf '%s' "$demo_probe" | grep -o '"version":"[^"]*"' | head -1))"
elif printf '%s' "$demo_probe" | grep -q 'token'; then
  demo_warn=1
  echo "   ! demo connector REJECTED the published token — it has probably been"
  echo "     rotated on the box. Update DEMO_TOKEN in demo/connector.ts."
  echo "     (setoku.com itself deployed fine.)"
else
  demo_warn=1
  echo "   ! demo box did not answer (down, redeploying, or unreachable from here)."
  echo "     Not treating this as a deploy failure. Re-check later:"
  echo "     curl -sS -X POST \"\$(bun -e 'import {DEMO_MCP_URL} from \"./demo/connector\"; console.log(DEMO_MCP_URL)')\""
fi

# The published app links rot the same way — an admin flipping an app from public
# back to team turns an advertised /p/<id> into a 404 with nothing in git changing.
for id in $(bun -e 'import { DEMO_PUBLIC_APPS } from "./demo/connector"; console.log(DEMO_PUBLIC_APPS.map(a => a.id).join(" "))'); do
  code=$(curl -s -o /dev/null --max-time 12 -w '%{http_code}' "https://demo.setoku.com/p/${id}" || true)
  if [ "$code" = "200" ]; then
    printf '   ✓ demo app /p/%s\n' "${id:0:12}…"
  else
    demo_warn=1
    printf '   ! demo app /p/%s returned %s — advertised on setoku.com but not public.\n' "${id:0:12}…" "$code"
  fi
done
[ "$demo_warn" -ne 0 ] && echo "   (demo warnings above do not block the deploy)"

echo "✓ site deployed."
