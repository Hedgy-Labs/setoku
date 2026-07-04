# SPDX-License-Identifier: Apache-2.0
# Business-DB → lake mirror. Build from the repo root (compose does).
FROM oven/bun:1-slim
WORKDIR /app
COPY ingest/pg-mirror/mirror.ts ./
# Same allow/deny source of truth as the gateway image: the baked project dir.
# Operators who bake their own .setoku/config.json get the identical list here.
COPY deploy/project-template /project
ENV SETOKU_PROJECT_DIR=/project
CMD ["bun", "mirror.ts"]
