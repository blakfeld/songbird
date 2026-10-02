# Tasks

## 1. Configuration

- [x] 1.1 Add `SONGBIRD_DATABASE_URL` (an optional `SecretString`) and `SONGBIRD_DATABASE_MAX_CONNECTIONS` (1–100, default 10) to `Config` in `backend/crates/api/src/config.rs`, and document both in `backend/.env.example`. Verify with unit tests: blank URL means the default, pool size 0 is rejected naming the variable, `Debug` output never contains the URL, and the existing env-documentation test passes.

## 2. Database layer

- [x] 2.1 Add `sqlx` (`any`, `sqlite`, `postgres`, `runtime-tokio`, `tls-rustls`, `migrate`), `uuid` (v7), and `tempfile` (dev) to `backend/crates/api/Cargo.toml`. Verify that `cargo build -p api` passes.
- [x] 2.2 Implement the `db` module (D2): scheme detection, the default `sqlite://data/songbird.db?mode=rwc` with parent-directory creation, rejection of `:memory:` and unknown schemes, SQLite `after_connect` pragmas, and `DbError` with a redacted URL. Verify with unit tests for each URL case (including a Postgres URL with `sslmode=verify-full&sslrootcert=...` being accepted with those options applied), plus a test showing that `PRAGMA foreign_keys` reads 1 on a pooled SQLite connection.
- [x] 2.3 Add `migrations/sqlite/0001_init.sql` and `migrations/postgres/0001_init.sql` (no-ops). Embed both migrators, and run the right one in `Db::connect`. Add the parity test comparing `(version, description)` lists. Verify that the parity test passes and fails when a file is added to only one set.
- [x] 2.4 Write `backend/crates/api/src/db/README.md` with the portable SQL conventions (D4). Verify that it covers ids, times, booleans, JSON, case-insensitivity, placeholders, allowed and avoided syntax, and how to add a migration to both sets.

## 3. Service wiring

- [x] 3.1 Add `Db` to `AppState`, and connect and migrate in `main.rs` before binding the listener, exiting non-zero on failure. Verify with an integration-level test calling the startup function: a fresh temp dir creates `data/songbird.db`, an unknown applied migration version fails naming the version, and a bad Postgres password fails without the password in the error text.
- [x] 3.2 Add `GET /readyz` and `ApiError::NotReady` (D5) on the public router. Verify with integration tests: 200 `{"status":"ready"}` with a working DB, 503 `not_ready` after the pool is closed, and `/healthz` still 200 in that state.

## 4. Test harness

- [x] 4.1 Implement `tests/common/db.rs` `test_db()` (D6): temp SQLite by default, a per-test Postgres database when `SONGBIRD_TEST_POSTGRES_URL` is set, drop on `Drop`, and a stale-database sweep. Add a test pinning `$1` placeholder binding on both backends. Verify that `cargo test -p api` passes with and without the Postgres variable, and that no `songbird_test_*` databases remain afterwards.
- [x] 4.2 Update every existing integration test constructor (`chat`, `codex_warning`, `patterns`, `service`, `songs`, `track_generation`) to build `AppState` with `test_db()`. Verify that `cargo test --workspace` passes.
- [x] 4.3 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`. Verify that both pass.

## 5. Dev, Docker, and CI

- [x] 5.1 Make these updates:
  - `.gitignore`: add `backend/data/` and `data/`.
  - `justfile`: add `dev-pg` and `test-backend-pg`.
  - `docker-compose.yml`: add the `songbird-data` volume on the backend, a `postgres` profile service with a healthcheck, and a commented URL switch.
  - Backend Dockerfile: create `/app/data` owned by the runtime user.

  Verify that `docker compose up` serves `/readyz` 200 on SQLite, and that `docker compose --profile postgres up` with the URL set serves `/readyz` 200 on Postgres.
- [ ] 5.2 Add a `postgres:16` service to `.github/workflows/ci.yml` and a `just test-backend-pg` step after `just test`. Verify that the CI run on the branch is green, with both passes visible in the log.
- [x] 5.3 Document the database settings, the SQLite default and its limits, switching to Postgres, `/readyz`, and running tests on Postgres in `backend/README.md`. Verify that the documented commands run as written.

## 6. Integration

- [x] 6.1 Run `just lint` and `just test`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
