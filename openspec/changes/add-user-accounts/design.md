# Design

## Context

- **Backend:** today the backend is stateless. It is an axum 0.8 app (`backend/crates/api`) with no database and no auth. Its router is assembled in `routes.rs`, with a fallback, a 64 KiB body limit (2 MiB under `/api/v1/songs/`), CORS (GET/POST, `Content-Type` only, no credentials), and tracing. `AppState` holds providers, instruments, and `Arc<Config>`. Config comes from `SONGBIRD_*` env vars, and a test asserts the env example documents exactly those vars.
- **Proxy:** the browser always calls relative `/api/...`, and `next.config.ts` rewrites those calls to the backend. The site is therefore same-origin in dev, e2e, and docker, so a cookie session works without CORS credentials. A consequence is that the backend sees `Host: backend:8080` (or `localhost:8181`), never the host the browser used.
- **Frontend persistence:** songs are in IndexedDB behind `SongLibrary` (`frontend/src/lib/song/songLibrary.ts`). The library is already injectable into `StudioPage`, `SongLibraryMenu`, `SendToSongButton`, and `SongFileActions`. Scratch patterns are in localStorage via zustand `persist` (`lib/patternStore.ts`, key `songbird.patterns.<instrument>.v1`). The last-opened song is in `songbird.studio.lastSong`. `add-audio-tracks` plans a `songbird-samples` IndexedDB store.
- **Tests:** backend integration tests build the router in-process (`api::app(AppState{..})` + `oneshot`). Playwright starts `cargo run -p api` on :8181 and `next dev` on :3100, and its specs go straight to `/studio`.
- **Database:** `add-database-foundation` provides `Db`, an `sqlx` `AnyPool` that is SQLite by default and Postgres by URL. It also provides per-backend migration sets with a parity test, the portable SQL conventions (text UUIDv7 ids, integer Unix-ms times, JSON as text, normalise-then-`UNIQUE`, `$N` placeholders), and a `test_db()` harness. This change depends on it.
- **Production:** `add-vps-deployment` runs one VPS with Caddy as the outermost proxy (Caddy → Next → backend) and a provider-managed Postgres whose automated backups and point-in-time restore are the provider's.
- **Decisions already made by the user:** email + password, accounts created by an operator CLI only, SQLite in development with provider-managed Postgres (with provider backups) in production, local songs abandoned, scratch patterns kept local but per user.
- **Security review:** a review of this plan raised findings H1–H2, M1–M7, and L1–L7. They are folded into the decisions below. Where the user had no answer, a default was chosen and is marked *default chosen pending user confirmation*.

## Goals / Non-Goals

**Goals:**
- The server, not the browser, is the authority on who a user is and which projects they own.
- Keep the existing `SongLibrary` interface, so that Studio UI code changes as little as possible.
- Keep the backend test suite fast and in-process.
- Bound what one account, or one stranger, can cost: CPU for password hashing, paid AI calls, and storage.

**Non-Goals:**
- Self-service sign-up, email verification, password reset by email, OAuth, MFA, roles or admin UI, and sharing projects between users.
- "Log out everywhere" as a user-facing control. An operator `set-password` already ends all of a user's sessions, which covers the lost-device case at this scale. *(Default chosen pending user confirmation.)*
- Moving scratch patterns, lyrics, or UI preferences to the server.
- Horizontal scaling of the login throttle and the per-minute AI limit (see Risks).
- Offline editing.

## Decisions

### D1. Tables on the shared database layer, portable schema
The accounts tables are added as `0002_accounts.sql` in both `migrations/sqlite/` and `migrations/postgres/`, following the foundation's conventions. All queries are runtime-checked `sqlx::query`/`query_as` against `Db`.

- `users(id TEXT pk, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, disabled BOOLEAN/INTEGER NOT NULL DEFAULT false/0, created_at, updated_at)`. The email is stored trimmed and lowercased, so the plain `UNIQUE` index is case-insensitive.
- `sessions(token_hash TEXT pk, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, created_at, last_seen_at, expires_at)`, with an index on `user_id`. `token_hash` is the hex SHA-256 hash of the token. It is stored as text, not `bytea`/`BLOB`, so the column type is the same on both backends.
- `projects(id TEXT pk, owner_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, name TEXT NOT NULL, time_signature TEXT NOT NULL, track_count INTEGER NOT NULL, song TEXT NOT NULL, size_bytes INTEGER NOT NULL, revision BIGINT/INTEGER NOT NULL DEFAULT 1, created_at, updated_at)`, with an index on `(owner_id, updated_at)`.
- `ai_usage(user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (user_id, day))`, where `day` is days since the Unix epoch in UTC (D12).

Times are `BIGINT`/`INTEGER` Unix milliseconds set from Rust. `name`, `time_signature`, `track_count`, and `size_bytes` are copied from the song on every write, so listing and quota checks never parse `song`. Every foreign key cascades, so `user delete` (D7) removes a user's data in one statement.
- *Why `song` is text and not `jsonb`:* the server never queries inside a song, and text keeps both backends identical. It is also exactly what D2 needs to keep unknown fields.
- *Revision check:* `UPDATE projects SET ..., revision = revision + 1 WHERE id = $1 AND owner_id = $2 AND revision = $3 AND updated_at <= $4` (where `$4` is now minus the save interval, D2). Zero rows affected is then told apart by a follow-up `SELECT revision, updated_at FROM projects WHERE id = $1 AND owner_id = $2`: no row is `not_found`, a different revision is `revision_conflict`, otherwise the save came too soon (`too_many_requests`). The follow-up is owner-scoped because an unscoped one would answer `409` for another user's project and so reveal that the id exists. This needs no backend-specific locking.
- *Quota checks are transactional:* create and save first run `UPDATE users SET updated_at = updated_at WHERE id = $owner` inside the transaction, then check the project count and `SUM(size_bytes)` before writing. Touching the owner row takes a row lock on Postgres and the write lock on SQLite, so two concurrent creates for one user cannot both pass a count check that only one of them should, and it needs no `FOR UPDATE` (which SQLite lacks).

### D2. Store the song as raw JSON, validate through the typed model
Handlers receive the song as `serde_json::Value`. They deserialize a copy into `music::song::Song` and run `Song::validate`, but they store the original `Value`, serialised to text.
- *Why:* round-tripping through the Rust struct would drop unknown fields. The project-file and multitrack specs require unknown fields to survive.
- **Ids:** on `POST`, any client `song.id` is overwritten with the new server id, because the client cannot know it yet and must not be able to pick one. On `PUT`, a `song.id` that differs from the path id is refused with `422 id_mismatch` instead of being overwritten. A mismatch means the client is confused about which project it is editing, and silently overwriting would save one song's content into another project. *(Default chosen pending user confirmation; it resolves the earlier conflict between the spec and this decision.)*
- **Abuse limits:** 500 projects and 100 MiB of stored song text per user, and at most one save per project per second (`429` with `Retry-After`). They are constants, not config, because they are safety rails rather than tuning knobs, and the client's 300 ms debounce already keeps normal editing well under one save a second. A request to `DELETE` or `PUT` an id that is missing or owned by someone else gets `404`.

### D3. Opaque server-side sessions in an HttpOnly cookie
- The session token is 32 random bytes from `OsRng`, base64url-encoded. The database stores `sha256(token)`, so a leaked `sessions` table cannot be replayed.
- **Cookie name:** `__Host-songbird_session` when `Secure` is on, and `songbird_session` otherwise. The `__Host-` prefix makes browsers refuse the cookie unless it is `Secure`, has `Path=/`, and has no `Domain`, so a sibling subdomain or a plain-http response cannot plant or overwrite it. Browsers also reject `__Host-` cookies over http, which is why development falls back to the plain name. Both names live in one shared constant on each side (backend and `proxy.ts`).
- The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` unless `SONGBIRD_COOKIE_SECURE=false`. Dev, e2e, and docker-compose set it to false because they run over plain http.
- **Startup guard:** `SONGBIRD_COOKIE_SECURE=false` together with any `https://` entry in `SONGBIRD_CORS_ORIGINS` refuses to start, naming both variables. An https origin means a real deployment, where a non-`Secure` session cookie would leak over any accidental http request. *(Default chosen pending user confirmation.)*
- **Login always mints a new token** and deletes any session the request carried, so a token planted before login (session fixation) never becomes authenticated.
- **Logout** clears the cookie with the same name, `Path`, `Secure`, `HttpOnly`, and `SameSite` it was set with, because browsers treat a clearing cookie with different attributes as a different cookie and keep the original.
- Idle expiry slides. `last_seen_at` and `expires_at` are bumped at most once a minute per session, to avoid a write on every request. A 30-day absolute cap is also stored.
- Expired sessions are deleted lazily when they are looked up, and by an hourly `tokio` sweep.
- *Alternatives:* signed JWTs. They were rejected because revocation is a requirement ("kicked out" on disable, password change, and logout), and that needs a server lookup anyway.

### D4. Auth as an axum extractor plus a router layer
- A `CurrentUser` extractor looks up the session by cookie and joins `users` for `disabled = false`. On failure it returns `ApiError::Unauthenticated`.
- A `route_layer` (`from_fn_with_state`) on the protected `/api/v1` router enforces authentication before any handler runs, so a new route cannot forget it. After it authenticates, it records `user_id` on the request's tracing span (D14).
- **Origin check** runs for every method other than GET/HEAD on both the protected router and the auth router (login and logout). It allows a missing `Origin` and otherwise allows only origins listed in `SONGBIRD_CORS_ORIGINS`.
  - *Why configured origins only:* behind the Next rewrite the backend sees `Host: backend:8080`, so "the request's own host" never matches a real browser origin, and trusting `Host` would let a request vouch for itself.
  - *Why login and logout too:* without it, a cross-site page can log a victim into the attacker's account (login CSRF), or log them out.
  - *Why a missing Origin is allowed:* browsers always send `Origin` on cross-site non-GET requests, and scripts and the operator's `curl` don't.
  - The rule depends on no GET or HEAD endpoint changing state. That is stated in the spec so that future routes keep it.
- *Why the Origin check at all:* `SameSite=Lax` already blocks cross-site POSTs carrying the cookie in modern browsers. The Origin check is a cheap second defence against CSRF and needs no token plumbing.
- **`Cache-Control: no-store`** is set by a layer on every `/api/v1` response, including errors, so a shared or browser cache never keeps another user's projects or `me` response. The Next rewrite passes it through.
- `ApiError` gains these variants:
  - `Unauthenticated` (401 `unauthenticated`)
  - `InvalidCredentials` (401 `invalid_credentials`)
  - `Forbidden` (403 `forbidden`)
  - `NotFound` (404 `not_found`)
  - `RevisionConflict` (409 `revision_conflict`)
  - `ProjectLimit` (409 `project_limit`), used for both the count and the byte quota
  - `IdMismatch` (422 `id_mismatch`)
  - `TooManyRequests { retry_after }` (429 `too_many_requests`)
  - `ServerBusy { retry_after }` (503 `server_busy`)
- CORS gains PUT and DELETE methods, so that a configured cross-origin dev frontend can still preflight them. Credentials stay off, because the supported deployment is same-origin through the Next rewrite.

### D5. Passwords and login timing
- Passwords are hashed with `argon2` (argon2id, default params: m=19 MiB, t=2, p=1), run in `spawn_blocking` so the async runtime isn't stalled.
- **Bounded hashing:** every hash and verify in the server takes a permit from a global `tokio::sync::Semaphore` sized to the available parallelism, clamped to 2–4. It uses `try_acquire`, and when no permit is free the login answers `503 server_busy` with `Retry-After: 1` at once, without queueing.
  - *Why:* each verify costs about 19 MiB and a full core for tens of milliseconds. Without a bound, a burst of logins from many addresses (which the per-address throttle doesn't stop) exhausts memory and starves every other request.
  - *Why not queue:* a queue only moves the memory to waiting tasks and adds latency that makes clients retry anyway.
  - *Why 503 and not 429:* it is server capacity, not this client's behaviour, and keeping the codes apart lets monitoring tell a busy server from a throttled client.
- **Order of checks:** throttle (D6) → record the attempt → take a permit → verify. Recording before hashing means parallel requests cannot all pass the throttle before any of them has failed.
- For an unknown or disabled email, the handler still verifies the password against a dummy hash. The dummy is computed once at startup **from the current parameters**, so a miss costs the same as a real verify even after the parameters are tuned.
- **Rehash on login:** after a successful verify, if the stored hash's parameters differ from the current ones, the server rehashes the password (under the same permit) and stores it. This lets the open question on parameters be settled later without forcing password resets. It does not end sessions, because the password itself is unchanged.
- The login password is deserialised straight into a `SecretString`, whose `Debug` is redacted, so it cannot reach a log through a stray `{:?}` (D14).
- Emails are trimmed and lowercased on write and lookup.

### D6. Login throttle in memory
- **Keys and limits**, all over a sliding 15-minute window:
  - per (email, client address): 5 failures → `429` with `Retry-After`, even with the correct password;
  - per client address: 20 failures across all emails → `429`;
  - per email, from every address: above 50 failures, each further attempt is **delayed** before it is checked (1 s, doubling, capped at 30 s), but not refused.
- *Why the split:* a hard per-email limit lets anyone lock a victim out from any address, which is the same flaw that ruled out a per-account lock. The strict limit is therefore per (email, address), and the per-email limit only slows guessing from many addresses down to a couple of tries a minute while the real user still gets in. *(Default chosen pending user confirmation.)*
- The delay is served before a hashing permit is taken, so delayed requests don't hold one.
- A pending attempt counts as a failure until it finishes, so in-flight requests count toward every limit (D5 order). A success clears only its (email, address) entry. The per-email count ages out, because clearing it on success would let an attacker who interleaves with the real user's logins keep guessing at full speed.
- **Client address:** IPv6 addresses are reduced to their /64 before keying, because one host or subscriber normally controls a whole /64 and could rotate through it to evade per-address limits. IPv4 addresses are used whole.
  - When `SONGBIRD_TRUST_PROXY=true`, the address is the **first** entry of `X-Forwarded-For`. That entry is trustworthy only when the outermost proxy replaces any client-supplied `X-Forwarded-For` with the real peer address, as Caddy does by default in `add-vps-deployment`. The README says so, because enabling the flag behind a proxy that appends instead would let every client choose its own address.
  - Otherwise it is the socket address.
  - *Proxy topology (default chosen pending user confirmation):* on the VPS, Caddy is the outermost proxy and overwrites `X-Forwarded-For`, so `SONGBIRD_TRUST_PROXY=true` is set there only. It stays false everywhere else. The backend logs a warning at startup when it is false and `SONGBIRD_CORS_ORIGINS` contains an `https://` origin. That pairing is the clearly implementable signal of "deployed behind a proxy", where a false flag means every client shares the proxy's address, so the per-address limit becomes one global limit that a stranger can trip for everyone.
- *Why in memory:* a single backend instance is the supported deployment, and the throttle needs no durability.
- *Alternative:* a per-account lock in the `users` table. It was rejected because it can be used to lock a victim out, and it leaks account existence through the behaviour difference.

### D7. Operator CLI on the same binary
`api user create|set-password|disable|enable|delete|list` are subcommands of the existing binary. They are parsed with `clap`, and running with no subcommand serves as today.
- Passwords are read with `rpassword` when stdin is a TTY, and as one line from stdin otherwise (for scripts and e2e seeding). They are never read from argv.
- `set-password` and `disable` delete all of the user's sessions in the same transaction, so a password change doubles as "log out everywhere" for the operator.
- `delete` removes the user, which cascades to their projects, sessions, and AI usage rows (D1). On a TTY it asks the operator to retype the email; otherwise it needs `--yes`, so that a mistyped script cannot delete an account silently. The README notes that provider backups keep the deleted data until they age out of the provider's retention window. *(Default chosen pending user confirmation.)*
- *Why the same binary:* it shares config loading and migrations, and Docker gets it for free (`docker compose exec backend api user create ...`).

### D8. Frontend: Next 16 `proxy.ts` gate, plus a 401 handler
- `frontend/src/proxy.ts` matches every page except `/login`, `/healthz`, `/readyz`, `/_next`, static assets, and `/api`. When the session cookie is absent, it redirects to `/login?next=<path>`. It only checks that the cookie is present. The backend is the authority, and validating there would need a server-to-server call per navigation. The Next 16 file name and matcher API must be confirmed against `frontend/node_modules/next/dist/docs/` before implementing.
  - *Why `/healthz` and `/readyz` are excluded:* the proxy runs before rewrites, and health probes (the deploy script, uptime monitors) never carry a cookie. Without the exclusion they would get a redirect instead of the backend's answer, and the deploy health gate would test the wrong thing.
  - It looks for `__Host-songbird_session` and falls back to `songbird_session`, from the same shared constants as D3, because the frontend doesn't know whether the backend runs with `Secure`.
- `lib/api.ts`'s `request()` treats any `401 unauthenticated` as a sign-out. It calls a single `signOutLocally()`, which clears per-user storage (D10) and does `window.location.assign('/login?next=' + current path)`. A full navigation drops in-memory stores and undo history.
- An `AuthProvider` loads `GET /api/v1/auth/me` once and exposes `{user}`. The header shows the email and a Log out button. Logout first flushes the song library's pending save.
- **Return-target sanitiser:** `const u = new URL(next, location.origin)`. If `u.origin !== location.origin`, the target is `/`. Otherwise it navigates to `u.pathname + u.search + u.hash`.
  - *Why parse instead of checking that it starts with `/` and not `//`:* browsers treat `\` as `/` and drop tabs and newlines in URLs, so `/\evil.example` and `/%09/evil.example` pass a prefix check and still leave the site. Letting the URL parser decide, then comparing origins, uses the same rules the browser will use. Rebuilding from the path parts also drops any `javascript:` scheme, whose origin is `null` anyway.

### D9. `SongLibrary` over HTTP
- `createServerSongLibrary(api)` implements the existing `SongLibrary` interface (`list`, `create`, `open`, `peek`, `put`, `rename`, `duplicate`, `remove`, `save`, `flush`, `autosave`, `status`) on top of `/api/v1/projects`.
- It keeps the 300 ms debounce and an in-memory map of `id → revision`, and sends `revision` with every PUT.
- A `409 revision_conflict` sets a new `status.conflict` flag, which `StudioPage` renders as a banner with "Reload" and "Save as copy". Autosave for that song stops until one is chosen.
- A `429` reschedules the pending save after `Retry-After` and is not shown as a failure, because it only means the save interval (D2) hasn't passed.
- Other failures set the existing `failed` flag and retry with backoff.
- `rename` and `duplicate` are composed client-side (open, then PUT or POST).
- The IndexedDB implementation and the `idb-keyval` dependency are deleted.
- `beforeunload` warns while a save is pending.

### D10. Per-user browser storage
- **Every `songbird.*` localStorage key is per-user**, and so is the planned `songbird-samples` IndexedDB store. `signOutLocally()` removes every `songbird.*` localStorage key and every IndexedDB store listed in a single registry, `lib/auth/perUserStores.ts`. A new store must be added to that registry. A Vitest test scans the source for `idb-keyval` `createStore(...)` names and `localStorage` key literals and fails when one is outside the registry or the `songbird.` prefix.
  - *Why everything:* "only clear the keys that hold user data" relies on each future author deciding correctly. Losing UI preferences (panel heights, metronome, MIDI device) on logout is a small cost for an invariant that can't be missed. *(Default chosen pending user confirmation.)*
- Keys still carry the user id where data is personal: the last-opened song key becomes `songbird.studio.lastSong.<userId>`, and the pattern store's persist key becomes `songbird.patterns.<userId>.<instrument>.v1`. If the tab closes before the sign-out finishes clearing, the next user still reads only their own keys.
- The pattern store is created after `me` resolves, so there is no flash of another user's pattern.
- Old `songbird.songs.v1.*` IndexedDB entries are left untouched, as the user chose ("abandon"). They predate accounts, belong to no user, and are listed in the registry as explicitly excluded so that the scan test doesn't flag them.

### D11. Tests
- **Backend:** integration tests use the foundation's `test_db()` (temp SQLite, or Postgres when `SONGBIRD_TEST_POSTGRES_URL` is set) plus a new helper, `login_as(&db, email)`, that seeds a user and returns a session cookie. CI's existing Postgres pass covers both backends. Security-specific tests:
  - every `/api/v1/projects/{id}` method run as user B against user A's id gives `404`, and A's project is unchanged;
  - N parallel logins (N larger than the permit count) never hold more than the permit count at once, and the rest get `503` or `429`;
  - a log-capturing subscriber shows that neither the submitted password nor the `Set-Cookie` token value appears in any log line during login.
- **Playwright:** the e2e backend uses `SONGBIRD_DATABASE_URL=sqlite://<tmp>/e2e.db` and `SONGBIRD_CORS_ORIGINS=http://localhost:3100`, because the Origin check (D4) now accepts only configured origins. A `globalSetup` deletes that file, runs `api user create` for `e2e@example.com` with the password on stdin, then logs in through the API and saves `storageState`, which all specs use. A dedicated `auth.spec.ts` runs without that state.
- **Vitest:** library and Studio tests inject a fake `SongLibrary` or mock `fetch`. `fake-indexeddb` usage for songs is removed.

### D12. Per-user limits on paid AI endpoints
Every endpoint that calls an AI provider sits on one `ai` sub-router with a metering `route_layer`. Today that is `POST /api/v1/patterns/generate`, `POST /api/v1/songs/tracks/generate`, and `POST /api/v1/songs/chat`, and the planned lyrics and chords generation endpoints must be mounted there too.
- **Per minute:** an in-memory sliding window per user, `SONGBIRD_AI_REQUESTS_PER_MINUTE` (default 10).
- **Per day:** `INSERT ... ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1 RETURNING count` on `ai_usage`, against `SONGBIRD_AI_REQUESTS_PER_DAY` (default 200). It is counted before the provider is called, because a failed or timed-out call still costs money.
- Over either limit: `429 too_many_requests` with `Retry-After` (seconds until the window frees or until UTC midnight), and the provider is not called.
- *Why:* accounts stop strangers, but one compromised or careless account could still run up the provider bill. The provider's spend limit stays the backstop, and this keeps any one user from reaching it.
- *Why the daily count is in the database:* every deploy restarts the backend, and an in-memory daily count would refill on each one. One upsert per AI call is negligible next to the call itself.
- A test asserts that each known AI route returns `429` once the quota is spent, so a provider-calling route mounted outside the sub-router is caught when it is added to that list. *(Default chosen pending user confirmation.)*

### D13. Security headers from the Next config
`next.config.ts` `headers()` sets, on every response it serves:
- `Content-Security-Policy`: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`, with `'unsafe-eval'` added in development only for React refresh;
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: same-origin`.

Caddy keeps `Strict-Transport-Security`.
- *Why Next and not Caddy:* the headers then travel with the app into every topology (dev, docker, VPS), and the CSP sits next to the code whose needs it describes. HSTS stays in Caddy because it only makes sense where TLS terminates. *(Default chosen pending user confirmation.)*
- *Why a baseline CSP with `'unsafe-inline'` scripts:* a nonce-based CSP would force every page to render dynamically. The baseline still blocks framing, plugin content, foreign scripts and connections, and base-tag tricks.

### D14. Logging that cannot leak credentials
- The login request type holds the password as `SecretString`. Auth handlers carry no `#[instrument]`, or use `skip_all`, so arguments never become span fields.
- `TraceLayer` records method, path, status, and latency, and no headers, because `Cookie` and `Set-Cookie` carry session tokens.
- After authentication, the auth layer records `user_id` (never the email) on the request span, so a user's requests can be traced without putting personal data into logs that may be shipped elsewhere.
- A failed login is logged with the client address (as bucketed in D6) and a hex SHA-256 of the normalised email, which correlates repeated attempts against one account without writing the email into logs.

## Risks / Trade-offs

- [Behavior differences between SQLite and Postgres (case-sensitivity, constraint errors, and concurrent updates)] → Emails are normalised in Rust. Unique violations are detected through `sqlx`'s `DatabaseError::is_unique_violation()` rather than error-code strings. Revision conflicts use the conditional `UPDATE` (D1). Every accounts test runs on both backends in CI.
- [The in-memory throttle and per-minute AI limit reset on restart and are not shared across instances] → Acceptable for the single-instance deployment. The limitation is noted in the README. A move to Postgres or Redis is possible later without changing the spec. The daily AI quota is in the database for this reason.
- [`SONGBIRD_TRUST_PROXY` set behind a proxy that appends to `X-Forwarded-For`] → Every client could choose its own address and dodge the per-address limits. The README states the precondition, the flag defaults to false, and the VPS plan sets it only where Caddy is outermost. If a CDN is ever put in front of Caddy, the flag must be revisited.
- [Delayed login attempts pile up as sleeping tasks] → Each is a small future holding no hashing permit, and the per-address limits cap how many one address can start.
- [The `proxy.ts` gate only checks that the cookie is present] → A stale cookie renders the page shell, then the first API call returns 401 and redirects. No data leaks, because every API call is authenticated.
- [Autosave over the network is slower and can fail] → Debounce, retry, the visible "not being saved" state, and the `beforeunload` warning. Revisions prevent silent clobbering across tabs.
- [Abandoned local songs feel like data loss] → Called out in the proposal as BREAKING. The migration note in the multitrack spec describes the manual export and import path.
- [The argon2 cost under login bursts] → Hashing is in `spawn_blocking` behind a 2–4 permit semaphore (D5), and the throttle caps attempts.
- [The baseline CSP breaks something (an audio worklet, a dev tool)] → The CSP is one string in `next.config.ts`, and the Playwright suite runs with it on, so a breakage shows up in CI rather than in production.
- [Logout clears UI preferences] → Accepted for the simpler "every `songbird.*` key is per-user" rule (D10).
- [Deleted users remain in provider backups] → Documented in the README. They age out with the provider's retention window.
- [The Song document is validated with export rules] → If `polish-studio-ux` (zero tracks) lands first, projects automatically accept empty songs. If not, a new user's first empty song would fail. Order the work so that `polish-studio-ux` merges first, or create the first song with the current default tracks until it does.

## Migration Plan

1. Ensure `add-database-foundation` is deployed. Production uses the provider-managed Postgres from `add-vps-deployment` through `SONGBIRD_DATABASE_URL`. Set `SONGBIRD_COOKIE_SECURE=false` only for http deployments; the startup guard (D3) refuses it with an https origin.
2. Take a provider snapshot (or note the time for a point-in-time restore), then deploy the backend. Migration `0002_accounts` runs on start.
3. Create accounts with `api user create`.
4. Deploy the frontend.

Rollback: redeploy the previous images. The old build's migrator refuses a database with the unknown `0002` migration, so restore the database first, from the provider snapshot or point-in-time restore taken in step 2. The accounts data is new, so nothing older is lost, and browser IndexedDB songs are still there because they were never deleted.

## Open Questions

- Exact argon2 parameters can be tuned after measuring login latency on the deploy host. This doesn't affect the specs or tasks, because existing hashes are upgraded on the next login (D5).
- The defaults marked *pending user confirmation* (proxy topology in D6, login limits in D6, AI limits in D12, the `PUT` id rule in D2, no "log out everywhere", `user delete` in D7, per-user stores in D10, headers in D13, and the cookie startup guard in D3) are in effect unless the user changes them.
