# Design

## Context

- **Backend:**
  - It is one axum binary. It runs migrations at startup and keeps several per-process limits: the login throttle, AI limits, and the generation semaphore.
  - SQLite already uses WAL on every pooled connection (`backend/crates/api/src/db/mod.rs`).
  - The default URL `sqlite://data/songbird.db?mode=rwc` (`db/target.rs`) creates a missing file silently.
  - `/healthz` touches nothing, and `/readyz` runs `SELECT 1` with a 2 s timeout (`routes.rs`).
- **Frontend:** Next 16 standalone. `SONGBIRD_API_URL` is baked in at build time (`frontend/next.config.ts`). `proxy.ts` already exempts `/healthz` and `/readyz` from the login redirect.
- **Shutdown:** both services drain open requests for up to 190 s on SIGTERM (`prepare-services-for-fly`).
- **Fly facts this design relies on:**
  - A volume attaches to one Machine, and a Machine created without a mount can't gain one.
  - `fly scale count` creates new, empty volumes for new Machines.
  - `release_command` runs without volumes.
  - `kill_timeout` can be at most 300 s.
  - `Fly-Client-IP` is set by the edge and can't be spoofed.
  - Fly runs its own init as PID 1, so the image's entrypoint isn't PID 1.
- **Starting point:** the API was already launched as `songbird-op1hog` from `backend/`, with a public `http_service` on 8080 and no volume.

## Goals / Non-Goals

**Goals:**
- One `fly deploy` from the repo root ships the whole app.
- The database survives deploys and restarts, and a missing volume can never go unnoticed.
- The API is not reachable from the internet.
- About $5/month.

**Non-Goals:**
- High availability or zero-downtime deploys. With one Machine and one volume, a deploy is a stop followed by a start.
- Continuous backups (Litestream) and CI deploy with rollback. Both are left to a follow-up change.
- A custom domain. Adding one later means `fly certs add`, `SONGBIRD_CORS_ORIGINS`, and a README note.

## Decisions

### D1. One app, one image, one Machine
```
browser --TLS--> Fly edge (force_https, sets Fly-Client-IP)
   --> songbird-op1hog Machine
         docker-entrypoint.sh (root: check + chown, then setpriv to songbird)
           ├─ next-server   0.0.0.0:3000   rewrites /api/*, /healthz, /readyz
           │      └─ http://127.0.0.1:8080
           └─ songbird-api  127.0.0.1:8080
         /app/data volume (SQLite, WAL)
```
The web image is built with `SONGBIRD_API_URL=http://127.0.0.1:8080`, so the build-time rewrite target is always correct.

*Alternative:* two apps, with a public web app and a private API app over `.internal`. That gives independent deploys and lets the web Machine stop on its own, but it costs a second Machine, a second `fly.toml`, and private-network setup. It was the original plan. The user chose one image for simplicity. A deploy now always restarts both services, which a one-Machine API forced anyway.

### D2. The entrypoint supervises both services
`docker-entrypoint.sh` (bash, which is already in the base image) does the following, in order:
1. Exits 1 unless `/app/data` is a mountpoint.
2. Exits 1 unless `SONGBIRD_DATABASE_URL` starts with `sqlite:///app/data/`, so a stray override can't move the database off the volume.
3. Runs `chown songbird:songbird /app/data`, because a fresh volume is root-owned.
4. Installs the TERM/INT trap before starting anything, so an early signal can't orphan the services.
5. Starts each service by backgrounding `setpriv` directly, not through a shell function. A function would fork a subshell, so `$!` would name the subshell and the signal would never reach the service.
6. Waits with `wait -n`. If either service exits, it sends TERM to the other and waits for both. It then exits 0 if a signal started the shutdown, and 1 otherwise, so Fly restarts the Machine.

*Alternative:* a supervisor such as s6 or tini plus a config. This was rejected because it adds a dependency to do what about 30 lines of bash do, and the drain behaviour lives in the services themselves.

### D3. Machine configuration (`fly.toml` at the repo root)
- `[mounts]`: `source = "songbird_data"`, `destination = "/app/data"`. Fly's daily volume snapshots are the only backup until the Litestream change.
- `kill_signal = "SIGTERM"`, `kill_timeout = 200`. That is longer than the 190 s drain cap.
- `[env]`:
  - `SONGBIRD_ENV = "production"`
  - `SONGBIRD_CORS_ORIGINS = "https://songbird-op1hog.fly.dev"`
  - `SONGBIRD_TRUST_PROXY = "fly-client-ip"`
- The image, not `fly.toml`, sets `SONGBIRD_BIND_ADDR`, `SONGBIRD_DATABASE_URL`, `PORT`, and `HOSTNAME`, because they describe how the image is laid out, not where it runs.
- `[http_service]`: `internal_port = 3000`, `force_https = true`, and auto stop/start with `min_machines_running = 0`. Stopping when idle is safe because the volume persists, and an open SSE stream keeps the Machine busy.
- VM: `shared-cpu-1x`, 1 GB, which leaves room for both processes and argon2 logins.

### D4. Health check through the web server
`[[http_service.checks]]` sends `GET /readyz` every 15 s with a 5 s timeout and a 30 s grace period. Next rewrites it to the API's `/readyz`, so one check proves the web server, the API, and the database.

*Alternative:* a TCP check on 3000. This was rejected because it passes while the API is down.

### D5. Client address and origin
Next's rewrite proxy passes incoming headers through, so the API sees the edge's `Fly-Client-IP`. The origin check compares the browser's `Origin`, which the rewrite leaves alone, with `SONGBIRD_CORS_ORIGINS`. The public URL is therefore the right value.

### D6. Operator commands
`fly ssh console -C "setpriv --reuid=songbird --regid=songbird --init-groups songbird-api user create ..."`. The commands run as the service user, because a root-owned `-wal` or `-shm` file would stop the app writing.

## Risks / Trade-offs

- [Only daily snapshots back up the database] → Accepted until the Litestream follow-up. The README says so.
- [Someone scales to 2 Machines] → Each would get its own empty volume and diverge. The README and a `fly.toml` comment forbid it.
- [Every deploy restarts both services, and requests 502 during the restart] → Accepted for a prototype. The drain covers in-flight streams.
- [The existing Machine has no volume and can't gain one] → The README says to destroy it and redeploy. Nothing is lost, because its database is on a filesystem every deploy wipes.
- [Next may buffer `text/event-stream` through the rewrite] → Check streaming on the first production deploy. If it is buffered, set `compress: false` in `next.config.ts`.
