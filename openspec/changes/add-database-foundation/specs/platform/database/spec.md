## Purpose

Gives the API service persistent storage that runs on SQLite for development and tests, and on Postgres in production, with the same code and the same behavior on both.

## ADDED Requirements

### Requirement: Database backend chosen by URL
The service SHALL connect to the database named by `SONGBIRD_DATABASE_URL`.
- A URL starting with `sqlite:` SHALL use SQLite.
- A URL starting with `postgres:` or `postgresql:` SHALL use Postgres.
- Any other scheme SHALL make startup fail, with a message naming `SONGBIRD_DATABASE_URL` and the supported schemes.
- When the variable is unset or blank, the service SHALL use SQLite at `./data/songbird.db`, relative to its working directory.
- A SQLite file and its directory SHALL be created if they don't exist.
- The same build SHALL support both backends without recompiling.

#### Scenario: Default SQLite
- **WHEN** the service starts with `SONGBIRD_DATABASE_URL` unset in a directory with no `data/` folder
- **THEN** it creates `data/songbird.db`, applies migrations, and serves requests

#### Scenario: Postgres by URL
- **WHEN** the service starts with `SONGBIRD_DATABASE_URL=postgres://songbird:pw@db:5432/songbird`
- **THEN** it connects to that Postgres database and serves requests

#### Scenario: Unsupported scheme
- **WHEN** the service starts with `SONGBIRD_DATABASE_URL=mysql://localhost/songbird`
- **THEN** the process exits non-zero, and the error names `SONGBIRD_DATABASE_URL` and lists `sqlite` and `postgres`

### Requirement: SQLite safety settings
When using SQLite, every connection SHALL turn on foreign-key enforcement, use write-ahead logging, and wait at least 5 seconds for a lock before failing, so that concurrent requests don't fail just because another request is writing.

#### Scenario: Foreign keys enforced
- **WHEN** a migration defines a foreign key and a statement inserts a row referencing a missing parent on SQLite
- **THEN** the statement fails, as it does on Postgres

### Requirement: Migrations at startup
The service SHALL keep a separate ordered set of migrations for each backend. The two sets SHALL have the same versions and descriptions and SHALL produce equivalent schemas. On startup, before accepting requests, the service SHALL apply every migration that the database has not yet recorded. When a migration fails, or the database records a migration this build doesn't know, the service SHALL exit non-zero with a message naming the migration. Startup messages SHALL NOT contain database credentials.

#### Scenario: Fresh database
- **WHEN** the service starts against an empty database
- **THEN** all migrations are applied and recorded before the first request is served

#### Scenario: Already migrated
- **WHEN** the service restarts against a database that has every migration
- **THEN** no migration is re-applied

#### Scenario: Database from a newer build
- **WHEN** the database records a migration version this build doesn't contain
- **THEN** the process exits non-zero and the message names that version

#### Scenario: Migration sets stay in step
- **WHEN** the test suite runs
- **THEN** it fails if the SQLite and Postgres migration sets differ in versions or descriptions

#### Scenario: Credentials not shown
- **WHEN** the service cannot connect to `postgres://songbird:s3cret@db/songbird`
- **THEN** the process exits non-zero, and neither the message nor any log line contains `s3cret`

### Requirement: Readiness check
The service SHALL expose `GET /readyz`. It SHALL respond `200` with `{"status":"ready"}` when a trivial database query succeeds within 2 seconds. Otherwise it SHALL respond `503` in the standard error shape with code `not_ready`, without exposing database details. It SHALL NOT require authentication.

#### Scenario: Database reachable
- **WHEN** a client requests `GET /readyz` and the database answers
- **THEN** the response is `200` with `{"status":"ready"}`

#### Scenario: Database down
- **WHEN** the Postgres server stops and a client requests `GET /readyz`
- **THEN** the response is `503` with code `not_ready`, while `GET /healthz` still responds `200`

### Requirement: Same behavior on both backends
Every database-backed feature SHALL behave the same on SQLite and Postgres. Its integration tests SHALL be runnable against either backend. Each test SHALL get its own freshly migrated database, so that tests can't see each other's data. Tests SHALL use a temporary SQLite database by default, and Postgres when `SONGBIRD_TEST_POSTGRES_URL` is set. Continuous integration SHALL run the database-backed tests on both backends.

#### Scenario: Default test run needs no server
- **WHEN** a developer runs the backend tests with no database configured
- **THEN** the database-backed tests run on temporary SQLite databases and pass

#### Scenario: Postgres test run
- **WHEN** the backend tests run with `SONGBIRD_TEST_POSTGRES_URL` pointing at a Postgres server
- **THEN** each database-backed test runs on its own new Postgres database, which is removed afterwards
