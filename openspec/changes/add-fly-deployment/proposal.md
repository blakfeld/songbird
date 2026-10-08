# Proposal

## Why

Songbird has no production deployment yet. The earlier plan, `add-vps-deployment`, used managed Postgres (about $15/month), which is more than this prototype's budget. It also required a hand-built server, proxy, deploy script, and rollback. Fly.io can run the app as it is today, on SQLite, for about $5–10/month, and it provides TLS, rollouts, and health checks. This change replaces `add-vps-deployment`.

## What Changes

- **Two Fly apps.**
  - **Web app:** stateless and public. It runs the Next frontend and forces HTTPS.
  - **API app:** private. It runs the Rust backend on exactly one Machine with a persistent volume at `/app/data` holding the SQLite database. It has no public service and is reachable only over Fly's private network at `<api-app>.internal:8080`. The web app's API rewrite targets that address.
- **Continuous backups.**
  - Litestream wraps the API process and streams every database change to a Tigris bucket, keeping 7 days of point-in-time history.
  - On boot, an empty volume is restored from the bucket automatically.
- **Fail-safe start.** The API container refuses to start in two cases:
  - `/app/data` is not a mounted volume.
  - No database exists and no backup was found, unless the operator explicitly allows a new database. This covers the first launch, and a deliberate fresh start after the backups have been confirmed lost.

  Neither case can then produce a new, empty production database without anyone noticing.
- **CI deploy.**
  - A `deploy` job in `.github/workflows/ci.yml` runs only on pushes to `main` after the backend, frontend, and e2e jobs pass.
  - It builds and deploys the API, then the web app, with app-scoped deploy tokens, labelling each image with the commit SHA.
  - It checks `/healthz` through the public URL and redeploys the previous images if that check fails.
  - A manual workflow redeploys any earlier SHA.
- **Operator docs.** A deploy README covers:
  - first launch;
  - setting secrets;
  - running `api user` and `api keys` commands on the Machine as the service user;
  - rehearsing a restore;
  - why the API must never be scaled past one Machine.
- **Superseded.** The `add-vps-deployment` change is replaced. Its VPS, Caddy, cloud-init, SSH deploy script, managed Postgres, and basic-auth gate are dropped. The gate is no longer needed because accounts already require login. That change should be deleted before this one is archived, because both add `platform/deployment`.

## Capabilities

### New Capabilities

- `platform/deployment`: how production is reached, where its data lives, how it is backed up and restored, and how CI deploys and rolls it back.

### Modified Capabilities

None. The app-level changes the deployment depends on are in `prepare-services-for-fly`: graceful shutdown, the `Fly-Client-IP` address source, and HSTS.

## Impact

- **New files:**
  - `backend/fly.toml`, `frontend/fly.toml`
  - `backend/litestream.yml`, `backend/docker-entrypoint.sh`
  - `.github/workflows/redeploy.yml`
  - `deploy/README.md`
- **Changed files:**
  - `backend/Dockerfile`: add Litestream and the entrypoint, which runs as root and drops privileges.
  - `frontend/Dockerfile`: take the API URL as a build argument; it already reads `SONGBIRD_API_URL`.
  - `.github/workflows/ci.yml`: add the deploy job.
- **Accounts and secrets:**
  - Fly org with two apps and a volume.
  - Tigris bucket (`fly storage create`).
  - GitHub `production` environment holding `FLY_API_TOKEN_API` and `FLY_API_TOKEN_WEB`.
  - Fly secrets: `SONGBIRD_MASTER_KEYS` and the Tigris credentials.
- **Depends on:** `prepare-services-for-fly`, which must ship first.
- **Cost:** two shared-cpu-1x Machines, a 1 GB volume, and Tigris storage come to about $5–10/month. The web app stops when idle.
