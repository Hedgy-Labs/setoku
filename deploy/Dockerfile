# Setoku gateway — deployed (HTTP) profile. One container per company.
# Build from the repo root:  docker build -f deploy/Dockerfile -t setoku-gateway .
FROM oven/bun:1-slim

# libgomp1 is needed by onnxruntime-node (the local embedder's CPU backend, the
# I8 opt-in). Cheap to include; the runtime is only loaded when SETOKU_EMBEDDINGS=1.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY plugin/package.json ./package.json
# plugin/package.json lists onnxruntime-node in trustedDependencies so its native
# postinstall runs here (Bun blocks untrusted postinstalls by default, which would
# leave the embedder unable to load).
RUN bun install --production --silent --no-progress

COPY plugin/gateway ./gateway
# the plugin manifest — single source of truth for the version (lib/version.ts);
# surfaced in MCP serverInfo + /health so a deploy is verifiable from a session.
COPY plugin/.claude-plugin/plugin.json ./plugin.json

# Bake the local embedding model into the image so the box never downloads it at
# runtime (deterministic, offline startup). Embeddings are required, so this is ON
# by default; pass --build-arg BAKE_EMBEDDINGS=0 only for a deliberately
# keyword-only build.
ARG BAKE_EMBEDDINGS=1
ENV SETOKU_EMBED_CACHE=/app/.fastembed
RUN if [ "$BAKE_EMBEDDINGS" = "1" ]; then \
      echo "baking bge-small-en-v1.5 into the image…" && \
      bun -e 'import { FlagEmbedding, EmbeddingModel } from "fastembed"; await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir: "/app/.fastembed" }); console.log("baked")'; \
    fi

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
