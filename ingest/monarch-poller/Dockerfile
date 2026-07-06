# SPDX-License-Identifier: Apache-2.0
# Monarch Money → ingest bridge. Zero deps (Bun built-ins only).
FROM oven/bun:1-slim
WORKDIR /app
COPY ingest/monarch-poller/poll.ts ./poll.ts
VOLUME /state
CMD ["bun", "poll.ts"]
