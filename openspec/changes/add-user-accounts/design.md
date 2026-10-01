# Design

## Context

- **Backend:** today the backend is stateless. It is an axum 0.8 app (`backend/crates/api`) with no database and no auth. Its router is assembled in `routes.rs`, with a fallback, a 64 KiB body limit (2 MiB under `/api/v1/songs/`), CORS (GET/POST, `Content-Type` only, no credentials), and tracing. `AppState` holds providers, instruments, and `Arc<Config>`. Config comes from `SONGBIRD_*` env vars, and a test asserts the env example documents exactly those vars.
- **Proxy:** the browser always calls relative `/api/...`, and `next.config.ts` rewrites those calls to the backend. The site is therefore same-origin in dev, e2e, and docker, so a cookie session works without CORS credentials.
- **Frontend persistence:** songs are in IndexedDB behind `SongLibrary` (`frontend/src/lib/song/songLibrary.ts`). The library is already injectable into `StudioPage`, `SongLibraryMenu`, `SendToSongButton`, and `SongFileActions`. Scratch patterns are in localStorage via zustand `persist` (`lib/patternStore.ts`, key `songbird.patterns.<instrument>.v1`). The last-opened song is in `songbird.studio.lastSong`.
- **Tests:** backend integration tests build the router in-process (`api::app(AppState{..})` + `oneshot`). Playwright starts `cargo run -p api` on :8181 and `next dev` on :3100, and its specs go straight to `/studio`.
- **Database:** `add-database-foundation` provides `Db`, an `sqlx` `AnyPool` that is SQLite by default and Postgres by URL. It also provides per-backend migration sets with a parity test, the portable SQL conventions (text UUIDv7 ids, integer Unix-ms times, JSON as text, normalise-then-`UNIQUE`, `$N` placeholders), and a `test_db()` harness. This change depends on it.
- **Decisions already made by the user:** email + password, accounts created by an operator CLI only, SQLite now with Postgres for production, local songs abandoned, scratch patterns kept local but per user.

## Goals / Non-Goals

**Goals:**
- The server, not the browser, is the authority on who a user is and which projects they own.
- Keep the existing `SongLibrary` interface, so that Studio UI code changes as little as possible.
- Keep the backend test suite fast and in-process.

**Non-Goals:**
- Self-service sign-up, email verification, password reset by email, OAuth, MFA, roles or admin UI, and sharing projects between users.
- Moving scratch patterns, lyrics, or UI preferences to the server.
- Horizontal scaling of the login throttle (see Risks).
- Offline editing.

## Decisions

### D1. Tables on the shared database layer, portable schema
The accounts tables are added as `0002_accounts.sql` in both `migrations/sqlite/` and `migrations/postgres/`, following the foundation's conventions. All queries are runtime-checked `sqlx::query`/`query_as` against `Db`.

- `users(id TEXT pk, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, disabled BOOLEAN/INTEGER NOT NULL DEFAULT false/0, created_at, updated_at)`. The email is stored trimmed and lowercased, so the plain `UNIQUE` index is case-insensitive.
- `sessions(token_hash TEXT pk, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, created_at, last_seen_at, expires_at)`, with an index on `user_id`. `token_hash` is the hex SHA-256 hash of the token. It is stored as text, not `bytea`/`BLOB`, so the column type is the same on both backends.
- `projects(id TEXT pk, owner_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, name TEXT NOT NULL, time_signature TEXT NOT NULL, track_count INTEGER NOT NULL, song TEXT NOT NULL, revision BIGINT/INTEGER NOT NULL DEFAULT 1, created_at, updated_at)`, with an index on `(owner_id, updated_at)`.

Times are `BIGINT`/`INTEGER` Unix milliseconds set from Rust. `name`, `time_signature`, and `track_count` are copied from the song on every write, so listing never parses `song`.
- *Why `song` is text and not `jsonb`:* the server never queries inside a song, and text keeps both backends identical. It is also exactly what D2 needs to keep unknown fields.
- *Revision check:* `UPDATE projects SET ..., revision = revision + 1 WHERE id = $1 AND owner_id = $2 AND revision = $3`. Zero rows affected is then told apart as `not_found` or `revision_conflict` by a follow-up owner-scoped `SELECT`. This needs no backend-specific locking.

### D2. Store the song as raw JSON, validate through the typed model
Handlers receive the song as `serde_json::Value`. They deserialize a copy into `music::song::Song` and run `Song::validate`, but they store the original `Value`, serialised to text, with `id` overwritten by the project id.
- *Why:* round-tripping through the Rust struct would drop unknown fields. The project-file and multitrack specs require unknown fields to survive.

### D3. Opaque server-side sessions in an HttpOnly cookie
- The session token is 32 random bytes from `OsRng`, base64url-encoded, in cookie `songbird_session`. The database stores `sha256(token)`, so a leaked `sessions` table cannot be replayed.
- The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` unless `SONGBIRD_COOKIE_SECURE=false`. Dev, e2e, and docker-compose set it to false because they run over plain http.
- Idle expiry slides. `last_seen_at` and `expires_at` are bumped at most once a minute per session, to avoid a write on every request. A 30-day absolute cap is also stored.
- Expired sessions are deleted lazily when they are looked up, and by an hourly `tokio` sweep.
- *Alternatives:* signed JWTs. They were rejected because revocation is a requirement ("kicked out" on disable, password change, and logout), and that needs a server lookup anyway.

### D4. Auth as an axum extractor plus a router layer
- A `CurrentUser` extractor looks up the session by cookie and joins `users` for `disabled = false`. On failure it returns `ApiError::Unauthenticated`.
- A `route_layer` (`from_fn_with_state`) on the protected `/api/v1` router enforces authentication before any handler runs, so a new route cannot forget it. The same layer runs the Origin check for non-GET/HEAD methods: it allows a missing `Origin`, and allows origins from `SONGBIRD_CORS_ORIGINS` or the request's own host.
- The login and logout routes live on a separate, unprotected router.
- *Why the Origin check:* `SameSite=Lax` already blocks cross-site POSTs carrying the cookie in modern browsers. The Origin check is a cheap second defence against CSRF and needs no token plumbing.
- `ApiError` gains these variants:
  - `Unauthenticated` (401 `unauthenticated`)
  - `InvalidCredentials` (401 `invalid_credentials`)
  - `Forbidden` (403 `forbidden`)
  - `NotFound` (404 `not_found`)
  - `RevisionConflict` (409 `revision_conflict`)
  - `ProjectLimit` (409 `project_limit`)
  - `TooManyRequests { retry_after }` (429 `too_many_requests`)
- CORS gains PUT and DELETE methods, so that a configured cross-origin dev frontend can still preflight them. Credentials stay off, because the supported deployment is same-origin through the Next rewrite.

### D5. Passwords and login timing
- Passwords are hashed with `argon2` (argon2id, default params: m=19 MiB, t=2, p=1), run in `spawn_blocking` so the async runtime isn't stalled.
- For an unknown or disabled email, the handler still verifies the password against a fixed dummy hash computed once at startup, so the response takes a similar time and doesn't reveal which accounts exist.
- Emails are trimmed and lowercased on write and lookup.

### D6. Login throttle in memory
- A `Mutex<HashMap>` of failure timestamps keyed by normalised email, and another keyed by client IP. The window is 15 minutes, with limits of 5 per email and 20 per IP. Entries are pruned on access.
- Client IP comes from the `X-Forwarded-For` header's last hop when `SONGBIRD_TRUST_PROXY` is set. Otherwise it is the socket address.
- *Why in memory:* a single backend instance is the supported deployment, and the throttle needs no durability.
- *Alternative:* a per-account lock in the `users` table. It was rejected because it can be used to lock a victim out, and it leaks account existence through the behaviour difference.

### D7. Operator CLI on the same binary
`api user create|set-password|disable|enable|list` are subcommands of the existing binary. They are parsed with `clap`, and running with no subcommand serves as today.
- Passwords are read with `rpassword` when stdin is a TTY, and as one line from stdin otherwise (for scripts and e2e seeding). They are never read from argv.
- `set-password` and `disable` delete the user's sessions in the same transaction.
- *Why the same binary:* it shares config loading and migrations, and Docker gets it for free (`docker compose exec backend api user create ...`).

### D8. Frontend: Next 16 `proxy.ts` gate, plus a 401 handler
- `frontend/src/proxy.ts` matches every page except `/login`, `/_next`, static assets, and `/api`. When the `songbird_session` cookie is absent, it redirects to `/login?next=<path>`. It only checks that the cookie is present. The backend is the authority, and validating there would need a server-to-server call per navigation. The Next 16 file name and matcher API must be confirmed against `frontend/node_modules/next/dist/docs/` before implementing.
- `lib/api.ts`'s `request()` treats any `401 unauthenticated` as a sign-out. It calls a single `signOutLocally()`, which clears per-user storage (D10) and does `window.location.assign('/login?next=' + current path)`. A full navigation drops in-memory stores and undo history.
- An `AuthProvider` loads `GET /api/v1/auth/me` once and exposes `{user}`. The header shows the email and a Log out button. Logout first flushes the song library's pending save.
- Return targets are sanitised to same-site paths (they must start with `/` and not `//`).

### D9. `SongLibrary` over HTTP
- `createServerSongLibrary(api)` implements the existing `SongLibrary` interface (`list`, `create`, `open`, `peek`, `put`, `rename`, `duplicate`, `remove`, `save`, `flush`, `autosave`, `status`) on top of `/api/v1/projects`.
- It keeps the 300 ms debounce and an in-memory map of `id → revision`, and sends `revision` with every PUT.
- A `409 revision_conflict` sets a new `status.conflict` flag, which `StudioPage` renders as a banner with "Reload" and "Save as copy". Autosave for that song stops until one is chosen.
- Other failures set the existing `failed` flag and retry with backoff.
- `rename` and `duplicate` are composed client-side (open, then PUT or POST).
- The IndexedDB implementation and the `idb-keyval` dependency are deleted.
- `beforeunload` warns while a save is pending.

### D10. Per-user browser storage
- The last-opened song key becomes `songbird.studio.lastSong.<userId>`.
- The pattern store's persist key becomes `songbird.patterns.<userId>.<instrument>.v1`. The store is created after `me` resolves, so there is no flash of another user's pattern.
- `signOutLocally()` removes every `songbird.patterns.*` and `songbird.studio.lastSong*` key. UI-only keys (panel heights, metronome, MIDI) are not per-user and are kept.
- Old `songbird.songs.v1.*` IndexedDB entries are left untouched, as the user chose ("abandon").

### D11. Tests
- **Backend:** integration tests use the foundation's `test_db()` (temp SQLite, or Postgres when `SONGBIRD_TEST_POSTGRES_URL` is set) plus a new helper, `login_as(&db, email)`, that seeds a user and returns a session cookie. CI's existing Postgres pass covers both backends.
- **Playwright:** the e2e backend uses `SONGBIRD_DATABASE_URL=sqlite://<tmp>/e2e.db`. A `globalSetup` deletes that file, runs `api user create` for `e2e@example.com` with the password on stdin, then logs in through the API and saves `storageState`, which all specs use. A dedicated `auth.spec.ts` runs without that state.
- **Vitest:** library and Studio tests inject a fake `SongLibrary` or mock `fetch`. `fake-indexeddb` usage for songs is removed.

## Risks / Trade-offs

- [Behavior differences between SQLite and Postgres (case-sensitivity, constraint errors, and concurrent updates)] → Emails are normalised in Rust. Unique violations are detected through `sqlx`'s `DatabaseError::is_unique_violation()` rather than error-code strings. Revision conflicts use the conditional `UPDATE` (D1). Every accounts test runs on both backends in CI.
- [The in-memory throttle resets on restart and is not shared across instances] → Acceptable for the single-instance deployment. The limitation is noted in the README. A move to Postgres or Redis is possible later without changing the spec.
- [The `proxy.ts` gate only checks that the cookie is present] → A stale cookie renders the page shell, then the first API call returns 401 and redirects. No data leaks, because every API call is authenticated.
- [Autosave over the network is slower and can fail] → Debounce, retry, the visible "not being saved" state, and the `beforeunload` warning. Revisions prevent silent clobbering across tabs.
- [Abandoned local songs feel like data loss] → Called out in the proposal as BREAKING. The migration note in the multitrack spec describes the manual export and import path.
- [The argon2 cost under login bursts] → Hashing is in `spawn_blocking`, and the throttle caps attempts.
- [The Song document is validated with export rules] → If `polish-studio-ux` (zero tracks) lands first, projects automatically accept empty songs. If not, a new user's first empty song would fail. Order the work so that `polish-studio-ux` merges first, or create the first song with the current default tracks until it does.

## Migration Plan

1. Ensure `add-database-foundation` is deployed. Production uses Postgres through `SONGBIRD_DATABASE_URL`. Set `SONGBIRD_COOKIE_SECURE=false` only for http deployments.
2. Deploy the backend. Migration `0002_accounts` runs on start.
3. Create accounts with `api user create`.
4. Deploy the frontend.

Rollback: redeploy the previous images. The old build's migrator refuses a database with the unknown `0002` migration, so roll back by restoring the pre-deploy database snapshot or by deleting the `0002` row and tables. The accounts data is new, so nothing older is lost, and browser IndexedDB songs are still there because they were never deleted.

## Open Questions

- Exact argon2 parameters can be tuned after measuring login latency on the deploy host. This doesn't affect the specs or tasks.
