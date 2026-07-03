# SPDX-License-Identifier: Apache-2.0
FROM oven/bun:1-slim
WORKDIR /app
COPY ingest/pg-mirror/mirror.ts ./mirror.ts
CMD ["bun", "mirror.ts"]
