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
set -a; source .env; set +a

STAMP="$(date -u +%F)"
mkdir -p backups/context

echo "[backup] knowledge store snapshot…"
docker-compose exec -T server rm -f /data/knowledge-snapshot.db
docker-compose exec -T server bun -e "
  const { Database } = require('bun:sqlite');
  new Database('/data/knowledge.db').exec(\"VACUUM INTO '/data/knowledge-snapshot.db'\");"
docker cp "$(docker-compose ps -q server)":/data/knowledge-snapshot.db "backups/context/knowledge-${STAMP}.db"
docker-compose exec -T server rm -f /data/knowledge-snapshot.db

echo "[backup] pg_dump context store…"
docker-compose exec -T postgres pg_dump -U postgres setoku | gzip > "backups/context/pg-setoku-${STAMP}.sql.gz"

if [[ -n "${SETOKU_BACKUP_S3_BUCKET:-}" ]]; then
  echo "[backup] upload to bucket + prune (14 d)…"
  docker-compose run --rm rclone copy /backups/context "remote:${SETOKU_BACKUP_S3_BUCKET}/context"
  docker-compose run --rm rclone delete --min-age 14d "remote:${SETOKU_BACKUP_S3_BUCKET}/context"
else
  echo "[backup] WARNING: no SETOKU_BACKUP_S3_BUCKET — snapshots are LOCAL ONLY (violates I4)" >&2
fi

if docker-compose ps --status running clickhouse 2>/dev/null | grep -q clickhouse; then
  if [[ -n "${SETOKU_BACKUP_S3_BUCKET:-}" ]]; then
    echo "[backup] clickhouse-backup create_remote…"
    docker-compose run --rm clickhouse-backup create_remote "nightly-${STAMP}"
  else
    echo "[backup] WARNING: lake running but no bucket — skipping clickhouse backup" >&2
  fi
fi

# keep 3 days of local copies (the bucket holds the real retention)
find backups/context -type f -mtime +3 -delete
echo "[backup] done."
