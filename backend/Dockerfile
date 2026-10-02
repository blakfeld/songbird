FROM rust:1.92-bookworm AS build
# aws-lc-rs (via rustls) compiles C code and needs cmake and clang.
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release -p api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home songbird
COPY --from=build /src/target/release/api /usr/local/bin/songbird-api
# The default SQLite file lives under the working directory; a named volume mounted here
# inherits this ownership, so the unprivileged user can create the database.
WORKDIR /app
RUN mkdir -p /app/data && chown songbird /app/data
USER songbird
# Listening on loopback inside a container would make the port unreachable.
ENV SONGBIRD_BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
CMD ["songbird-api"]
