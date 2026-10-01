# Design

## Context

- **Backend:** the API is an axum 0.8 service with no persistence. Its state is `AppState { providers, instruments, config: Arc<Config> }` (`backend/crates/api/src/state.rs`).
- **Config:** `Config::from_lookup` reads the `SONGBIRD_*` constants in `config.rs:14-25`. A test keeps `backend/.env.example` in sync with that list. Blank values count as unset. Secrets are wrapped in `secrecy`.
- **Tests:** integration tests in `backend/crates/api/tests/*.rs` build the app in-process with `api::app(AppState{..})` and drive it with `oneshot`. There is no external process.
- **CI:** one ubuntu job runs `just lint` and `just test`.
- **Downstream:** `add-user-accounts` needs users, sessions, and projects tables, and will be revised to sit on this layer.

## Goals / Non-Goals

**Goals:**
- One binary and one set of query code that run on SQLite and Postgres, chosen at runtime.
- Zero-setup development and tests on SQLite. Production runs Postgres.
- Every DB-backed feature is proven on both backends in CI, so the Postgres move is just a config change.

**Non-Goals:**
- Any application tables. Those belong to the features that need them.
- Data migration from SQLite to Postgres. Production starts on Postgres, and dev data is disposable. If that changes, a later change can add an export and import command.
- Read replicas, multi-instance coordination, and backups. Those are operator concerns, to be documented later.

## Decisions

### D1. `sqlx` with the `Any` driver
Use `sqlx::AnyPool` with `sqlx::any::install_default_drivers()`, built with the `sqlite` and `postgres` features. The URL scheme picks the driver.
- *Why:* there is a single query code path, with no generic plumbing through every repository, and it's the setup sqlx itself documents for runtime-selected backends.
- *Alternative:* a `Db` enum over `SqlitePool | PgPool`, or generic `Database` repositories. This keeps native types such as `uuid`, `jsonb`, and `timestamptz`, but doubles every query function or spreads generics everywhere. It's worth revisiting only if `Any`'s type limits hurt.
- *Alternative:* SeaORM. Its backend abstraction is good, but it brings a heavy ORM layer for a few tables, plus its own migration DSL.
- *Consequence:* `Any` only maps basic types (`bool`, integers, floats, `String`, `Vec<u8>`). The portable conventions in D4 follow from that.
- *Consequence:* runtime-checked `sqlx::query`/`query_as`, not the compile-time `query!` macros. Those macros need a live database or offline data per backend, which would complicate `just lint` and CI.

### D2. URL resolution and pool setup (`db` module)
`Db::connect(&DatabaseConfig) -> Result<Db, DbError>` handles parsing, defaults, pragmas, and migration in one place, so `main.rs` and tests share it. `Db` wraps the pool and the detected `Backend` (`Sqlite | Postgres`), and features take `&Db`.
- **Unset or blank URL:** `sqlite://data/songbird.db?mode=rwc`. The parent directory is created before connecting.
- **SQLite:**
  - Connect options are `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`, and `synchronous=NORMAL`. They are applied via `after_connect` (`PRAGMA` statements), because `Any` connect options can't express SQLite-specific settings. `:memory:` is rejected in the service, because each pooled connection would see a different database.
  - Pool size defaults to `SONGBIRD_DATABASE_MAX_CONNECTIONS` for reads, but SQLite allows a single writer. Busy timeout plus WAL is enough at this scale, and no separate writer pool is added.
- **Postgres:** TLS through rustls when the URL asks for it (`sslmode=require`).
- **Errors:** `DbError` messages use a redacted URL (scheme, host, and database name only), so credentials never reach logs. The URL is held as `SecretString` in `Config`.

### D3. Two migration directories, checked for parity
`backend/crates/api/migrations/sqlite/` and `migrations/postgres/` are embedded with two `sqlx::migrate!` invocations. The `Backend` chooses which `Migrator` runs. Both directories start with `0001_init.sql`, which is an empty no-op, so the mechanism and the `_sqlx_migrations` table are exercised from day one.
- *Why two sets:* DDL genuinely differs: `INTEGER PRIMARY KEY` vs `BIGINT GENERATED`, `BLOB` vs `BYTEA`, and partial index and type names. A shared file would force the lowest common denominator into DDL too.
- A unit test asserts that both migrators list identical `(version, description)` pairs. A `#[tokio::test]` runs both sets against a temp SQLite DB and, when available, Postgres, and compares the resulting table and column names.
- Unknown applied versions fail startup. This is sqlx's `ignore_missing = false` default, and it protects against running an older build on a newer database.

### D4. Portable SQL conventions
These are documented in `backend/crates/api/src/db/README.md`, and every later migration and query must follow them.

| Kind of value | SQLite | Postgres | Rust type |
|---|---|---|---|
| IDs | `TEXT` | `TEXT` | `String` holding a UUIDv7, generated in Rust (`uuid` crate) so they sort by creation time |
| Times | `INTEGER` | `BIGINT` | `i64`, Unix milliseconds produced in Rust (no `now()`/`CURRENT_TIMESTAMP` in queries) |
| Booleans | `INTEGER` 0/1 | `BOOLEAN` | `bool` (`Any` maps both) |
| JSON | `TEXT` | `TEXT` | the serialised value; it is never queried inside SQL |

- Case-insensitive uniqueness: normalise (for example, lowercase) in Rust before insert or lookup, and use a plain `UNIQUE` index.
- Placeholders are `$1, $2, …`. Postgres requires them, and SQLite accepts `$NNN`. `?` is never used.
- Allowed syntax: `RETURNING` and `ON CONFLICT … DO UPDATE/NOTHING`, which SQLite 3.35+ supports. The bundled `libsqlite3-sys` is recent.
- Avoided: `ILIKE`, `jsonb` operators, `SERIAL`, array types, and `LIMIT` without `ORDER BY`.

### D5. Readiness endpoint
`GET /readyz` runs `SELECT 1` with a 2-second `tokio::time::timeout`. It returns `200 {"status":"ready"}` on success, and on error or timeout returns `503` through a new `ApiError::NotReady` (`not_ready`, with a fixed message). It lives on the same unauthenticated router as `/healthz`. `/healthz` is untouched.

### D6. Test harness
`backend/crates/api/tests/common/db.rs` exposes `test_db() -> TestDb`, which derefs to `Db` and cleans up on `Drop`.
- **Default:** it creates a temporary SQLite database with `tempfile::TempDir`, which is deleted on drop, connects through `Db::connect`, and migrates.
- **With `SONGBIRD_TEST_POSTGRES_URL`:**
  - It connects to the server's maintenance database.
  - It runs `CREATE DATABASE songbird_test_<uuid>`, connects, and migrates.
  - On drop, a blocking task issues `DROP DATABASE … WITH (FORCE)`.
  - A startup sweep drops `songbird_test_*` databases older than an hour, in case a crashed run left some behind.
- `sqlx::test` is not used. It's tied to one concrete driver through `DATABASE_URL` and doesn't fit the `Any` setup.
- Existing tests that don't touch the database still construct `AppState` with a `test_db()`. That keeps one constructor path, and SQLite temp DBs cost milliseconds.

### D7. Dev, Docker, and CI
- **`justfile`:**
  - `dev` uses the SQLite default, so no change is needed.
  - New `dev-pg` runs `docker compose --profile postgres up -d postgres` and prints the URL to export.
  - New `test-backend-pg` runs the backend tests with `SONGBIRD_TEST_POSTGRES_URL` set.
- **`docker-compose.yml`:**
  - The backend gets volume `songbird-data:/app/data` (the SQLite default).
  - A `postgres` service (postgres:16, a healthcheck, and volume `pg-data`) is added under the `postgres` profile.
  - A commented `SONGBIRD_DATABASE_URL` shows how to switch.
  - The backend Dockerfile creates `/app/data`, owned by the runtime user.
- **CI:**
  - It adds a `postgres:16` service container.
  - After `just test`, it runs `just test-backend-pg`, so database-backed tests pass on both backends before merge.
  - SQLite needs nothing extra, because `libsqlite3-sys` is bundled.
- **`.gitignore`:** adds `backend/data/` and `data/`.

## Risks / Trade-offs

- [`Any` type limits (no native UUID, timestamp, or JSON)] → The D4 conventions make that explicit. Values are stored as text and integers, with conversion in Rust. If Postgres-native types are needed later, moving one repository to a `Db` enum is a contained refactor.
- [Behavior drift between backends] → D4 conventions, migration parity tests, and the CI run on both backends.
- [`$N` placeholders on SQLite] → SQLite treats `$1` as a named parameter. sqlx binds positionally, and this works, but a harness test pins the behavior so a sqlx upgrade can't silently break it.
- [SQLite single-writer contention] → WAL plus a 5 s busy timeout is fine for development and tests. Production uses Postgres, and the README states that SQLite is meant for development and single-user use.
- [SQLite file on an ephemeral container filesystem] → docker-compose mounts a named volume. The README warns that `/app/data` must be persistent if SQLite is used outside development.

## Migration Plan

There is no data to migrate. Deploy order:
1. Merge this change. The service creates `data/songbird.db` on first start in development, and production sets `SONGBIRD_DATABASE_URL` to Postgres.
2. Merge `add-user-accounts`, which adds its tables in `0002_*` for both backends.

Rollback: the previous build ignores the database entirely.
