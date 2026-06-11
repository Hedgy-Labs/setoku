# SPDX-License-Identifier: Apache-2.0
# Setoku slack-listener — Socket Mode daemon + backfill job (tasks 3.3/3.4).
# Zero npm dependencies: Bun built-ins only, so no install step.
# Build from the repo root:
#   docker build -f ingest/slack-listener/Dockerfile -t setoku-slack-listener .
FROM oven/bun:1-slim

WORKDIR /app
COPY ingest/slack-listener/listener.ts ingest/slack-listener/backfill.ts ./

# Spool-first durability (I4): events hit this volume before ClickHouse.
ENV SETOKU_SPOOL_DIR=/spool
VOLUME /spool

# /health for the compose healthcheck (compose-network only; never published — I1)
EXPOSE 8686

CMD ["bun", "listener.ts"]

# One-shot backfill (same image, same spool volume for the resumable state):
#   docker compose run --rm slack-listener bun backfill.ts
