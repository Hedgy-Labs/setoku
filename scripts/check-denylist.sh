#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# I3 enforcement: no pilot-tenant data in the repo.
#
# The actual denylist (real metric names, gotcha phrases, Slack channel names,
# domains, etc.) is maintained in the PRIVATE overlay, never here. Supply it via:
#   SETOKU_DENYLIST_FILE=/path/to/list   (one term per line, # comments ok), or
#   SETOKU_DENYLIST=$'term1\nterm2'      (e.g. from a GitHub Actions secret)
#
# Note: the word "Hedgy" itself is allowed — the README names the pilot tenant
# deliberately. What must never appear is the tenant's *data*.
set -euo pipefail

cd "$(dirname "$0")/.."

terms=""
if [[ -n "${SETOKU_DENYLIST_FILE:-}" && -f "${SETOKU_DENYLIST_FILE:-}" ]]; then
  terms="$(grep -v '^\s*#' "$SETOKU_DENYLIST_FILE" | grep -v '^\s*$' || true)"
elif [[ -n "${SETOKU_DENYLIST:-}" ]]; then
  terms="$(printf '%s' "$SETOKU_DENYLIST" | tr ',' '\n' | grep -v '^\s*$' || true)"
fi

if [[ -z "$terms" ]]; then
  echo "check-denylist: no denylist provided (SETOKU_DENYLIST_FILE / SETOKU_DENYLIST unset) — skipping."
  echo "check-denylist: in CI this should come from a repository secret sourced from the private overlay."
  exit 0
fi

fail=0
while IFS= read -r term; do
  hits="$(grep -rni --binary-files=without-match \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=out \
    --exclude=check-denylist.sh \
    -F -- "$term" . || true)"
  if [[ -n "$hits" ]]; then
    echo "DENYLIST HIT: '$term'"
    echo "$hits"
    fail=1
  fi
done <<< "$terms"

if [[ "$fail" -ne 0 ]]; then
  echo "check-denylist: FAILED — pilot-tenant terms found (I3)." >&2
  exit 1
fi
echo "check-denylist: clean ($(printf '%s\n' "$terms" | wc -l | tr -d ' ') terms checked)."
