#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Nightly backup (I4) — run from cron on the box (see deploy/backup/cron.example).
#
# 1. Knowledge store snapshot (SQLite VACUUM INTO — the irreplaceable asset:
#    curated human knowledge is not rebuildable).
# 2. pg_dump of the Postgres context store.
# 3. Upload both to S3-compatible object storage on a DIFFERENT provider than
#    the box, prune remote copies older than 14 days.
# 4. clickhouse-backup create_remote (its own retention: BACKUPS_TO_KEEP_REMOTE).
#
# With no bucket configured it still takes local snapshots under ./backups/
# and warns loudly — local-only backups do not satisfy I4.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deploy/dc.sh
set -a; source .env; set +a

STAMP="$(date -u +%F)"
mkdir -p backups/context

# Three SQLite files, each snapshotted with VACUUM INTO (a consistent copy
# under WAL, no downtime): knowledge.db (curated knowledge + published apps),
# apps.db (per-app state: annotations, votes), files.db (shared files — the box
# may hold the only copy). All three are durable user data (I4).
snapshot_db() {
  local name="$1"
  echo "[backup] ${name} snapshot…"
  dc exec -T server rm -f "/data/${name}-snapshot.db"
  dc exec -T server bun -e "
    const { Database } = require('bun:sqlite');
    const fs = require('node:fs');
    if (!fs.existsSync('/data/${name}.db')) { console.error('  (no /data/${name}.db yet — skipped)'); process.exit(0); }
    new Database('/data/${name}.db').exec(\"VACUUM INTO '/data/${name}-snapshot.db'\");"
  if dc exec -T server test -f "/data/${name}-snapshot.db"; then
    docker cp "$(dc ps -q server)":"/data/${name}-snapshot.db" "backups/context/${name}-${STAMP}.db"
    dc exec -T server rm -f "/data/${name}-snapshot.db"
  fi
}
snapshot_db knowledge
snapshot_db apps
snapshot_db files

# The Postgres context store is the reserved migration target (profile: pgstore)
# and is unused/off by default — dump it only when it's actually running, mirroring
# the clickhouse guard below. The irreplaceable asset is the SQLite snapshot above,
# which is always taken.
if dc ps --status running postgres 2>/dev/null | grep -q postgres; then
  echo "[backup] pg_dump context store…"
  dc exec -T postgres pg_dump -U postgres setoku | gzip > "backups/context/pg-setoku-${STAMP}.sql.gz"
fi

if [[ -n "${SETOKU_BACKUP_S3_BUCKET:-}" ]]; then
  echo "[backup] upload to bucket + prune (14 d)…"
  dc run --rm rclone copy /backups/context "remote:${SETOKU_BACKUP_S3_BUCKET}/context"
  dc run --rm rclone delete --min-age 14d "remote:${SETOKU_BACKUP_S3_BUCKET}/context"
else
  echo "[backup] WARNING: no SETOKU_BACKUP_S3_BUCKET — snapshots are LOCAL ONLY (violates I4)" >&2
fi

if dc ps --status running clickhouse 2>/dev/null | grep -q clickhouse; then
  if [[ -n "${SETOKU_BACKUP_S3_BUCKET:-}" ]]; then
    echo "[backup] clickhouse-backup create_remote…"
    dc run --rm clickhouse-backup create_remote "nightly-${STAMP}"
  else
    echo "[backup] WARNING: lake running but no bucket — skipping clickhouse backup" >&2
  fi
fi

# keep 3 days of local copies (the bucket holds the real retention)
find backups/context -type f -mtime +3 -delete
echo "[backup] done."
