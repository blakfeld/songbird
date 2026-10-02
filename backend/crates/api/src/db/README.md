# Database conventions

The service runs on SQLite (development, tests) or Postgres (production) from
one build, through sqlx's `Any` driver. `Any` only maps basic types, so every
migration and query follows these rules. A query that breaks one will pass on
one backend and fail on the other.

## Values

| Kind of value | SQLite | Postgres | Rust type |
|---|---|---|---|
| IDs | `TEXT` | `TEXT` | `String` holding a UUIDv7 generated in Rust (`uuid` crate), so ids sort by creation time |
| Times | `INTEGER` | `BIGINT` | `i64` Unix milliseconds produced in Rust. Never `now()` or `CURRENT_TIMESTAMP` in SQL |
| Booleans | `INTEGER` 0/1 | `BOOLEAN` | `bool` |
| JSON | `TEXT` | `TEXT` | the serialised value. It is never queried inside SQL, so no `jsonb` operators |

Reading a boolean needs care: `Any` will not decode a SQLite `INTEGER` as
`bool`, so try `bool` and fall back to `i64` (see `users::decode_bool`).

## Case-insensitive values

Normalise (for example, lowercase) in Rust before insert and before lookup,
and use a plain `UNIQUE` index. Do not use `COLLATE NOCASE`, `citext`, or
`ILIKE`: they do not exist on both backends.

## Queries

- Placeholders are `$1, $2, ...`. Postgres requires them and SQLite accepts
  them. Never use `?`.
- Allowed: `RETURNING` and `ON CONFLICT ... DO UPDATE / DO NOTHING` (SQLite
  3.35+, which the bundled `libsqlite3-sys` is).
- Avoided: `ILIKE`, `jsonb` operators, `SERIAL`, array types, and `LIMIT`
  without `ORDER BY` (row order differs between backends).
- Use `sqlx::query` / `query_as` at runtime. The `query!` macros are not used
  because they need a live database per backend at compile time.

## Adding a migration

1. Pick the next version, for example `0002_create_users`.
2. Create `migrations/sqlite/0002_create_users.sql` **and**
   `migrations/postgres/0002_create_users.sql`. DDL can differ (types,
   partial indexes), but the version, description, tables, and columns must
   match.
3. Never edit a migration that has shipped. Add a new one.
4. Run `cargo test -p api`. A unit test fails if the two directories list
   different `(version, description)` pairs, and a startup test refuses a
   database that has applied a version this build does not contain.
5. Run `just test-backend-pg` to check the Postgres file against a real server.

Foreign keys are enforced on SQLite because every connection enables
`PRAGMA foreign_keys`, so a migration can rely on them on both backends.
