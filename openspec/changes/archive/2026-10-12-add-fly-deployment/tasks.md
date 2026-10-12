# Tasks

## 1. Prerequisites

- [x] 1.1 Confirm that `prepare-services-for-fly` is merged to `main`: graceful shutdown, `SONGBIRD_TRUST_PROXY=fly-client-ip`, and HSTS.
- [x] 1.2 Confirm that `add-vps-deployment` has been deleted, so that only one change adds `platform/deployment`.

## 2. Image and entrypoint

- [x] 2.1 Add the root `Dockerfile` (D1): Rust and Next build stages, and a `node:22-bookworm-slim` runtime holding both. Add a root `.dockerignore`. Verify that `docker build .` succeeds.
- [x] 2.2 Add `docker-entrypoint.sh` (D2). Verify with `docker run`:
  1. With no volume, it exits 1 with the mount message.
  2. With `SONGBIRD_DATABASE_URL` off the volume, it exits 1 with the URL message.
  3. With a fresh, root-owned volume, `/readyz`, `/healthz`, and `/login` answer `200`, both services run as `songbird`, and the database files are on the volume.
  4. `docker stop` makes the API log its drain, and the container exits 0.
  5. Killing the API alone makes the container exit 1.
  6. A user created in one container still exists in a new container on the same volume.
- [x] 2.3 Rewrite `/readyz` to the API in `frontend/next.config.ts` (D4).

## 3. Fly configuration and docs

- [x] 3.1 Add the root `fly.toml` (D3, D4).
- [x] 3.2 Write `deploy/README.md`. It covers first launch and the volume, replacing a Machine that has no volume, secrets, operator commands as `songbird` (D6), the one-Machine rule, and backups being daily snapshots only.

## 4. Review

- [x] 4.1 Run `code-reviewer` on the change and resolve its findings.
