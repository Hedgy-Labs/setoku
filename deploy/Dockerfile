# Setoku gateway — deployed (HTTP) profile. One container per company.
# Build from the repo root:  docker build -f deploy/Dockerfile -t setoku-gateway .
FROM oven/bun:1-slim

WORKDIR /app
COPY plugin/package.json ./package.json
RUN bun install --production --silent --no-progress

COPY plugin/gateway ./gateway

# Project dir: config + (optionally) a context seed baked into the image.
# The seed imports into the knowledge store on first boot only.
COPY deploy/project-template /project
# To bake your company's knowledge seed in, add before building:
#   COPY path/to/your/.setoku/context /project/.setoku/context

ENV SETOKU_PROJECT_DIR=/project \
    SETOKU_DB_PATH=/data/knowledge.db \
    SETOKU_HTTP_PORT=8787

VOLUME /data
EXPOSE 8787

CMD ["bun", "gateway/http.ts"]
