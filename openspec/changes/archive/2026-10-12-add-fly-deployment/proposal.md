# Proposal

## Why

Songbird has no production deployment yet. The earlier plan, `add-vps-deployment`, used managed Postgres (about $15/month), which is more than this prototype's budget. It also required a hand-built server, proxy, deploy script, and rollback. Fly.io can run the app as it is today, on SQLite, for about $5/month, and it provides TLS, rollouts, and health checks. This change replaces `add-vps-deployment`.

The API was first launched on its own (`songbird-op1hog`) with a public port and no volume. That exposed the API directly and kept the database on the Machine's root filesystem, which every deploy wipes.

## What Changes

- **One Fly app, one image.** A root `Dockerfile` builds both the Next frontend and the Rust API into one image, and a root `fly.toml` deploys it to `songbird-op1hog`.
  - Next serves the only public port (3000) and forces HTTPS. It rewrites `/api/*`, `/healthz`, and `/readyz` to the API.
  - The API listens on `127.0.0.1:8080`, so it has no public address.
- **Persistent database.** A Fly volume `songbird_data` is mounted at `/app/data`, and `SONGBIRD_DATABASE_URL` points SQLite there.
- **Fail-safe start.** The container refuses to start when `/app/data` is not a mounted volume, or when `SONGBIRD_DATABASE_URL` points outside it.
- **Process supervision.** An entrypoint takes ownership of the volume as root, then runs both services as `songbird`. It forwards SIGTERM so both drain open streams, and it stops the Machine if either service dies on its own.
- **Health check.** Fly checks `GET /readyz` through Next, which proves the web server, the API, and the database in one probe.
- **Operator docs.** `deploy/README.md` covers first launch, the volume, secrets, operator commands, and the one-Machine rule.
- **Deferred.** Litestream backups and the CI deploy and rollback job are left to a later change. Until then, Fly's daily volume snapshots are the only backup.
- **Superseded.** The `add-vps-deployment` change is replaced.

## Capabilities

### New Capabilities

- `platform/deployment`: how production is reached, where its data lives, and how it starts, stops, and reports health.

### Modified Capabilities

None. The app-level changes the deployment depends on are in `prepare-services-for-fly`: graceful shutdown, the `Fly-Client-IP` address source, and HSTS.

## Impact

- **New files:** `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `fly.toml` (all at the repo root), `deploy/README.md`.
- **Changed files:**
  - `frontend/next.config.ts`: rewrite `/readyz` to the API.
  - `frontend/server-wrapper.mjs`: comment only.
- **Unchanged:** `backend/Dockerfile`, `frontend/Dockerfile`, and `docker-compose.yml` still run the services apart for local use.
- **Accounts and secrets:** the `songbird-op1hog` app, a 1 GB `songbird_data` volume, and the `SONGBIRD_MASTER_KEYS` secret.
- **Depends on:** `prepare-services-for-fly`, which has shipped.
- **Cost:** one shared-cpu-1x 1 GB Machine that stops when idle, plus a 1 GB volume: about $5/month.
