# Design

## Context

- **Backend:**
  - It is one axum binary. It runs migrations at startup and keeps several per-process limits: the login throttle, AI limits, and the generation semaphore.
  - SQLite already uses WAL on every pooled connection (`backend/crates/api/src/db/mod.rs:101`), which Litestream requires.
  - The default URL `sqlite://data/songbird.db?mode=rwc` (`db/target.rs:9`) creates a missing file silently.
  - The Dockerfile uses `debian:bookworm-slim`, `USER songbird`, and `WORKDIR /app`, and binds to `0.0.0.0:8080`.
- **Frontend:** Next 16 standalone. `SONGBIRD_API_URL` is baked in at build time (`frontend/next.config.ts:5,43-44`).
- **CI:** `.github/workflows/ci.yml` runs on `push` and `pull_request` for all branches, with jobs `backend`, `frontend`, and `e2e`.
- **Fly facts this design relies on:**
  - A volume attaches to one Machine.
  - `fly scale count` creates new, empty volumes for new Machines.
  - `release_command` runs without volumes.
  - `kill_timeout` can be at most 300 s.
  - The proxy idle timeout is about 60 s; the source is the Fly community forum, not the official docs.
  - `Fly-Client-IP` is set by the edge and can't be spoofed.
  - `.internal` names resolve over IPv6 and can't reach stopped Machines.
  - Deploy tokens can be scoped to one app.
- **Prerequisite:** `prepare-services-for-fly` ships first. It adds graceful shutdown with a 190 s cap, `SONGBIRD_TRUST_PROXY=fly-client-ip`, and HSTS.

## Goals / Non-Goals

**Goals:**
- Push to `main` reaches production in minutes, with no manual step after the first launch.
- No production data loss beyond a few seconds of replication lag, and no state in which an empty production database is created silently.
- About $5–10/month.

**Non-Goals:**
- High availability or zero-downtime API deploys. With one Machine and one volume, a deploy is a stop followed by a start.
- A custom domain. The first launch uses `<web-app>.fly.dev`. Adding a domain later means `fly certs add`, `SONGBIRD_CORS_ORIGINS`, and a README section, with no change to the design.
- A pre-login access gate. Accounts already require login for every page and API call.
- Staging environments.

## Decisions

### D1. Two apps: a public web app and a private API app
```
browser --TLS--> Fly edge (force_https, sets Fly-Client-IP)
   --> <web-app>   Next :3000, rewrites /api/*, /healthz
   --6PN http://<api-app>.internal:8080-->
       <api-app>   1 Machine: litestream replicate -exec songbird-api ([::]:8080)
                   /app/data volume (SQLite, WAL) --> Tigris bucket
```
The API app has no `[http_service]`, so it has no public route and the Fly proxy never auto-stops it. The web image is built with `SONGBIRD_API_URL=http://<api-app>.internal:8080`, a stable name, so the URL baked in at build time is correct.

*Alternatives:*
- One app with two process groups: these still run on separate Machines, but share one image and one deploy cadence.
- One Machine running both processes under a supervisor: saves about $2–3, but couples the deploys, needs more memory, and adds a supervisor to maintain.

Both are rejected, since the split costs about $2/month.

App names are global on Fly, so the actual names are chosen at first launch and stored in each `fly.toml` and in the CI workflow. This document writes them as `<web-app>` and `<api-app>`.

### D2. API Machine configuration (`backend/fly.toml`)
- `[mounts]`: `source = "songbird_data"`, `destination = "/app/data"`. Keep Fly's default daily volume snapshots as a second, independent backup.
- `kill_signal = "SIGTERM"`, `kill_timeout = 200`. That is longer than the app's 190 s drain cap, which leaves time for Litestream's final sync.
- `[deploy] strategy = "rolling"`. Bluegreen and canary would need a second Machine with the same volume, which can't exist.
- `[checks]`: an HTTP check on `/readyz` port 8080 with a 60 s grace period, to cover a restore on boot.
- `[env]`:
  - `SONGBIRD_BIND_ADDR = "[::]:8080"` (`.internal` resolves over IPv6)
  - `SONGBIRD_DATABASE_URL = "sqlite:///app/data/songbird.db?mode=rwc"`
  - `SONGBIRD_ENV = "production"`
  - `SONGBIRD_TRUST_PROXY = "fly-client-ip"`
  - `SONGBIRD_CORS_ORIGINS = "https://<web-app>.fly.dev"`
  - the Litestream bucket settings
- VM: `shared-cpu-1x`, 512 MB. Task 3.4 measures peak memory during concurrent argon2 logins. If it exceeds 400 MB, raise the size to 1 GB (about $3 more a month).

### D3. Web Machine configuration (`frontend/fly.toml`)
- `[build.args] SONGBIRD_API_URL = "http://<api-app>.internal:8080"`.
- `[http_service]`: `internal_port = 3000`, `force_https = true`, `auto_stop_machines = "stop"`, `auto_start_machines = true`, `min_machines_running = 0`.
  - Stopping when idle saves a few dollars on a prototype, at the cost of a cold start of about 1–2 s.
  - Setting `min_machines_running = 1` turns this off; it's a one-line change.
- A TCP check on port 3000. It doesn't use `/healthz`, because that path is rewritten to the API, and the web app's health would then depend on the API.
- `kill_signal = "SIGTERM"`, `kill_timeout = 200`, matching the frontend drain from `prepare-services-for-fly`.
- VM: `shared-cpu-1x`, 512 MB.

### D4. Litestream and the entrypoint
The `litestream` binary is pinned by version and checksum in the backend image, at v0.5.8 or later, which embeds CA roots.

`backend/litestream.yml` replicates `/app/data/songbird.db` to `s3://${BUCKET_NAME}/songbird.db`, using the Tigris endpoint from `AWS_ENDPOINT_URL_S3`. `fly storage create` sets that endpoint and the credentials as secrets. Retention is 168 h (7 days), with snapshots every 24 h.

Task 3.1 confirms the exact v0.5 config keys, including whether `region: auto` is needed. The research didn't verify them.

`backend/docker-entrypoint.sh` runs as root and does the following, in order:
1. `mountpoint -q /app/data`, or exit 1 with "data volume not mounted at /app/data".
2. `chown songbird:songbird /app/data` (a fresh volume is root-owned).
3. As `songbird`, via `setpriv`, run `litestream restore -if-db-not-exists -if-replica-exists /app/data/songbird.db`. Exit on error.
4. If `/app/data/songbird.db` still doesn't exist and `SONGBIRD_ALLOW_FRESH_DB` is not `1`, exit 1 with "no database and no backup found; set SONGBIRD_ALLOW_FRESH_DB=1 only for a first launch".
5. As `songbird`, `exec litestream replicate -exec "songbird-api"`.

Litestream passes SIGTERM to the child, waits for it to exit, and then syncs before exiting itself.

The fresh-database allowance is a Fly secret, set only for the first launch. It's a secret rather than `[env]` so that it never becomes part of the repository's configuration.

*Alternative:* a refuse-if-missing guard in Rust. The research found this needs a code change and a new env var, while the entrypoint already knows whether a restore happened. The entrypoint guard is kept so the backend is unaware of how it is hosted.

### D5. The CI deploy job
In `ci.yml`, add a `deploy` job:
- `needs: [backend, frontend, e2e]`
- `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`
- `environment: production`
- `concurrency: { group: production-deploy, cancel-in-progress: false }`

Steps:
1. `superfly/flyctl-actions/setup-flyctl` (pinned by SHA).
2. Record the restore point, the UTC time, and the current image of each app (`flyctl image show` or `flyctl releases --image`) in `$GITHUB_STEP_SUMMARY`.
3. `flyctl deploy --remote-only --image-label ${{ github.sha }}` in `backend/`, using `FLY_API_TOKEN_API`, with `--wait-timeout 5m`.
4. The same in `frontend/`, using `FLY_API_TOKEN_WEB`.
5. Poll `https://<web-app>.fly.dev/healthz` for up to 3 minutes.
6. On failure in steps 3–5, `flyctl deploy --image <recorded image>` for each app that changed, then fail the job.

`.github/workflows/redeploy.yml` (`workflow_dispatch`, input `sha`, same environment and concurrency group) deploys `registry.fly.io/<app>:<sha>` for both apps and runs the same health check.

The images built remotely are labelled with the commit SHA, which makes the manual redeploy deterministic. Task 4.1 confirms that `--image-label` produces `registry.fly.io/<app>:<sha>`. The research couldn't verify it.

*Alternative:* build in Actions and push to `registry.fly.io`. That gives more control over caching, but needs a Docker login with the deploy token and longer CI minutes. It's not worth it yet.

### D6. Operator commands
`fly ssh console -a <api-app> -C "setpriv --reuid=songbird --regid=songbird --init-groups songbird-api user create ..."`.

The commands run as the service user, because a root-owned `-wal` or `-shm` file would stop the app writing. The README documents a wrapper alias for this.

## Risks / Trade-offs

- [API deploys take the API down for up to drain time + boot + restore check, and requests 502 during that] → Accepted for a prototype. The drain covers in-flight streams, and the README says to deploy when nobody is mid-session if that matters.
- [A failed deploy may leave the new version running, because Fly doesn't auto-roll back] → D5 step 6 redeploys the recorded image.
- [Migrations are forward-only, so rolling back the image leaves the new schema in place, and the older binary refuses a database with unknown migrations] → Use Litestream point-in-time restore to the recorded restore point before redeploying (spec scenario "Bad migration undone"). The README's restore drill covers exactly this path.
- [Someone scales the API to 2 Machines] → The README warning, plus a CI step that fails the deploy if `flyctl machines list` shows more than one Machine for the API app.
- [The volume's host fails] → Restore on boot onto a new volume. Fly's daily snapshots are a second fallback.
- [Next may compress or buffer `text/event-stream` through the rewrite] → Task 5.2 verifies streaming on the first production deploy. If it's buffered, set `compress: false` in `next.config.ts`.
- [Tigris or Fly pricing and behaviour were partly taken from memory or community posts] → The tasks that touch them verify the specific claims before relying on them.
