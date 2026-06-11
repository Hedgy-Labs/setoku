#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Apply ingest/schemas/*.sql to the running lake (idempotent — all DDL is
# CREATE ... IF NOT EXISTS). The ClickHouse entrypoint runs these on FIRST
# boot only; run this after pulling new schemas onto an existing deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/dc.sh
set -a; source .env 2>/dev/null || true; set +a

for f in ingest/schemas/*.sql; do
  echo "[schemas] $f"
  dc exec -T clickhouse clickhouse-client \
    --user "${CLICKHOUSE_USER:-setoku}" --password "${CLICKHOUSE_PASSWORD}" \
    --multiquery < "$f"
done
echo "[schemas] done."
