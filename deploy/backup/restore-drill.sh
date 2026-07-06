#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Restore drill (2.5 AC): rebuild a working stack on a clean VM from bucket
# contents alone. Run it for real at least once — an untested backup is a wish.
#
# Prereqs on the clean box: this repo cloned, docker + compose, and a .env
# containing the SETOKU_BACKUP_* credentials plus fresh service secrets.
# Data gap is bounded by the nightly cadence (<24 h).
set -euo pipefail
cd "$(dirname "$0")/../.."
source deploy/dc.sh
set -a; source .env; set +a
: "${SETOKU_BACKUP_S3_BUCKET:?restore needs the backup bucket configured}"

echo "[drill] 1/5 start the lake…"
dc up -d --wait clickhouse

echo "[drill] 2/5 fetch latest context backups…"
dc run --rm rclone copy "remote:${SETOKU_BACKUP_S3_BUCKET}/context" /backups/context
latest_kdb="$(ls -1 backups/context/knowledge-*.db | sort | tail -1)"
latest_pg="$(ls -1 backups/context/pg-setoku-*.sql.gz 2>/dev/null | sort | tail -1)"
echo "        knowledge: ${latest_kdb}   pg: ${latest_pg:-<none — postgres store off by default>}"

echo "[drill] 3/5 restore context stores…"
# knowledge.db goes onto the data volume BEFORE the server starts
docker run --rm -v setoku_setoku_data:/data -v "$PWD/backups/context:/restore:ro" \
  alpine sh -c "cp /restore/$(basename "$latest_kdb") /data/knowledge.db"
# Restore the Postgres store only when a dump exists (profile: pgstore); bring the
# container up on demand since it's off by default.
if [[ -n "$latest_pg" ]]; then
  dc up -d --wait postgres
  gunzip -c "$latest_pg" | dc exec -T postgres psql -q -U postgres setoku
fi

echo "[drill] 4/5 restore the lake…"
latest_ch="$(dc run --rm clickhouse-backup list remote | awk '/nightly-/{name=$1} END{print name}')"
if [[ -n "$latest_ch" ]]; then
  dc run --rm clickhouse-backup restore_remote "$latest_ch"
else
  echo "        no remote clickhouse backup found — skipping lake restore" >&2
fi

echo "[drill] 5/5 start everything + verify…"
dc up -d --wait
# verify via the compose network, NOT the public edge: on a drill VM the real
# SETOKU_DOMAIN has no DNS/cert here, so https://localhost would fail even
# though the restore succeeded
health="$(dc exec -T server bun -e '
  fetch("http://127.0.0.1:8787/health")
    .then((r) => r.json())
    .then((j) => { console.log(JSON.stringify(j)); process.exit(j.ok ? 0 : 1); })
    .catch(() => process.exit(1));')" \
  || { echo "[drill] FAIL: gateway unhealthy" >&2; exit 1; }
docs="$(printf '%s' "$health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["docs"])')"
rows="$(dc exec -T clickhouse clickhouse-client --user "${CLICKHOUSE_USER:-setoku}" --password "${CLICKHOUSE_PASSWORD}" --query 'SELECT count() FROM setoku.ingest_raw' 2>/dev/null || echo n/a)"
echo "[drill] OK — knowledge docs: ${docs}, lake ingest_raw rows: ${rows}"
echo "[drill] now ask a real question through the MCP gateway to finish the drill."
