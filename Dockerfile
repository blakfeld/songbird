# The whole app in one image for a single Fly Machine: Next serves the public port and
# proxies /api to the Rust API on loopback, so the API is never exposed directly.
# backend/Dockerfile and frontend/Dockerfile stay for docker-compose, which runs them apart.

FROM rust:1.92-bookworm AS api
# aws-lc-rs (via rustls) compiles C code and needs cmake and clang.
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY backend/ .
RUN cargo build --release -p api

FROM node:22-bookworm-slim AS web
RUN corepack enable
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ .
# Rewrite destinations are baked in at build time, and the API shares this container.
ENV SONGBIRD_API_URL=http://127.0.0.1:8080
RUN pnpm build

# Bookworm to match the glibc the API binary was linked against in the build stage.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home songbird
COPY --from=api /src/target/release/api /usr/local/bin/songbird-api
COPY --from=web /app/.next/standalone /app/web
COPY --from=web /app/.next/static /app/web/.next/static
COPY --from=web /app/public /app/web/public
COPY --from=web /app/server-wrapper.mjs /app/web/server-wrapper.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
WORKDIR /app
RUN mkdir -p /app/data
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SONGBIRD_BIND_ADDR=127.0.0.1:8080 \
    SONGBIRD_DATABASE_URL=sqlite:///app/data/songbird.db?mode=rwc
EXPOSE 3000
# Starts as root only to take ownership of the volume, then drops to songbird.
ENTRYPOINT ["docker-entrypoint.sh"]
