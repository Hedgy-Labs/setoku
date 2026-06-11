#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Weekly Parquet export of every lake table to object storage — the
# portability guarantee: a standard open format any engine can read
# (clickhouse-local, DuckDB, pandas, Spark — reader's choice). Migration to a
# bigger node or ClickHouse Cloud never strands data.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deploy/dc.sh
set -a; source .env; set +a

: "${SETOKU_BACKUP_S3_ENDPOINT:?parquet export needs the backup bucket configured}"
: "${SETOKU_BACKUP_S3_BUCKET:?}" "${SETOKU_BACKUP_S3_ACCESS_KEY:?}" "${SETOKU_BACKUP_S3_SECRET_KEY:?}"

WEEK="$(date -u +%G-W%V)"
ch() { dc exec -T clickhouse clickhouse-client --user "${CLICKHOUSE_USER:-setoku}" --password "${CLICKHOUSE_PASSWORD}" --query "$1"; }

tables="$(ch "SELECT name FROM system.tables WHERE database='setoku' AND engine LIKE '%MergeTree'")"
for t in $tables; do
  echo "[parquet] setoku.${t} → ${SETOKU_BACKUP_S3_BUCKET}/parquet/${WEEK}/${t}.parquet"
  ch "INSERT INTO FUNCTION s3('${SETOKU_BACKUP_S3_ENDPOINT%/}/${SETOKU_BACKUP_S3_BUCKET}/parquet/${WEEK}/${t}.parquet', '${SETOKU_BACKUP_S3_ACCESS_KEY}', '${SETOKU_BACKUP_S3_SECRET_KEY}', 'Parquet')
      SELECT * FROM setoku.${t}
      SETTINGS s3_truncate_on_insert = 1"
done
echo "[parquet] done — week ${WEEK}, $(echo "$tables" | wc -w | tr -d ' ') table(s)."
