# SPDX-License-Identifier: Apache-2.0
# Gmail → ingest bridge. Zero deps (Bun built-ins only).
FROM oven/bun:1-slim
WORKDIR /app
COPY ingest/gmail-poller/poll.ts ./poll.ts
VOLUME /state
CMD ["bun", "poll.ts"]
