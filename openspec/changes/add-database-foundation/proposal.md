# Proposal

## Why

The backend is stateless today and has no database. User accounts and server-side projects (`add-user-accounts`) need persistent storage, and so will most later features. SQLite keeps local development and tests free of any setup. Production should run on Postgres. Choosing the backend by connection URL from day one, and testing against both, avoids a rewrite when production moves to Postgres.

## What Changes

- **A database layer in the API service.** The backend is chosen by the URL scheme of `SONGBIRD_DATABASE_URL`: `sqlite:` or `postgres:`/`postgresql:`. When the variable is unset, the service uses a SQLite file at `./data/songbird.db`, created on first start, so `just dev` works with no setup. Any other scheme fails startup.
- **Migrations on startup.** Each backend has its own versioned migration set. Pending migrations are applied before the service accepts requests, and a failure stops startup with a message that hides credentials. This change ships the migration mechanism with no application tables. Feature changes add their own migrations to both sets.
- **Readiness.** A new `GET /readyz` returns `200` when the database answers and `503` when it doesn't. `GET /healthz` stays a dependency-free liveness check.
- **Portable SQL conventions.** These keep queries working on both backends:
  - ids are stored as text UUIDs;
  - times as integer Unix milliseconds;
  - JSON as text;
  - case-insensitive values are normalised before storing;
  - only syntax both backends support.
- **Test harness.** Integration tests get an isolated, migrated database per test: a temporary SQLite file by default, or a fresh Postgres database when `SONGBIRD_TEST_POSTGRES_URL` is set. CI runs the database tests against both.
- **Ops.**
  - docker-compose keeps SQLite on a named volume by default, and an optional `postgres` profile runs the service on Postgres.
  - `just dev-pg` starts a local Postgres.
  - `backend/.env.example` and the README document the new settings.

## Capabilities

### New Capabilities
- `platform/database`: which database backends are supported and how one is chosen, the SQLite default, migrations at startup, the readiness endpoint, per-test isolated databases, and the portability rules both backends must pass.

### Modified Capabilities
- `platform/service-operations`: configuration gains the database URL, pool size, and SQLite default, and the health-check requirement notes that `/healthz` does not touch the database.

## Impact

- **Backend:**
  - New dependency: `sqlx` (`any`, `sqlite`, `postgres`, `runtime-tokio`, `tls-rustls`, `migrate`).
  - New `db` module in `backend/crates/api`, with URL parsing, pool construction, SQLite pragmas, and migration selection.
  - `migrations/sqlite/` and `migrations/postgres/`.
  - `AppState` gains a `Db` handle, and every test that builds `AppState` changes.
  - `Config` gains `SONGBIRD_DATABASE_URL` (treated as a secret) and `SONGBIRD_DATABASE_MAX_CONNECTIONS`. The env-documentation test and `backend/.env.example` are updated.
  - New `/readyz` route.
- **Infra:** `.gitignore` (`backend/data/`), `docker-compose.yml` (volume plus a `postgres` profile), `justfile`, and `.github/workflows/ci.yml` (a Postgres service and a second test pass).
- **Downstream:** `add-user-accounts` is revised to build on this layer and to follow the portable SQL rules instead of setting up Postgres itself.
