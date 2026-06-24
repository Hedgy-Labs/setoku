#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Knowledge drift canary (curation-cockpit-spec piece D) — runs the live-store
# knowledge lint inside the server container and FILES any failure as a pending
# correction. The flow "heals up to the gate": detect drift deterministically
# (a metric's SQL now errors, or returns an out-of-bounds value) → file it as a
# pending correction → it appears in the /admin curation cockpit → the auto-draft
# job drafts the fix → a human approves. Model-free (I8); no auto-commit.
#
# Cron it daily (deploy/backup/cron.example):
#   23 5 * * *  cd /opt/setoku && deploy/monitor/knowledge-canary.sh >> /var/log/setoku/canary.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== knowledge-canary $(date -u +%FT%TZ) ==="
# --file: file a pending correction per failing metric (deduped by the CLI).
# Never gates anything — this is detection, not enforcement.
docker compose exec -T server bun gateway/knowledge-lint.ts --file \
  || echo "(knowledge-lint reported failures — filed as pending corrections; review the cockpit)"
