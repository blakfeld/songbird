# Tasks

## 1. Schema and configuration

- [ ] 1.1 Confirm that `add-database-foundation` is merged (`Db`, both migration sets, and `test_db()` exist). Verify that `cargo test -p api` passes on main.
- [ ] 1.2 Extend `Config` with these vars and document them in `backend/.env.example`:
  - `SONGBIRD_COOKIE_SECURE` (default true)
  - `SONGBIRD_SESSION_IDLE_HOURS` (1–720, default 168)
  - `SONGBIRD_TRUST_PROXY` (default false)

  Verify with unit tests for out-of-range idle hours and the env-documentation test.
- [ ] 1.3 Write `0002_accounts.sql` in both `migrations/sqlite/` and `migrations/postgres/` (users, sessions, projects per design D1). Verify that the foundation's migration parity test passes and that `cargo test -p api` runs green both with and without `SONGBIRD_TEST_POSTGRES_URL`.
- [ ] 1.4 Add the `login_as(&db, email)` test helper to `tests/common`. Verify with a test that uses it to call an authenticated endpoint once group 3 lands. Until then, verify that the helper inserts a user and a session row.

## 2. Accounts, passwords, and CLI

- [ ] 2.1 Implement a `users` repository: create (lowercased, trimmed email, unique), find by email, set password, set disabled, and list. Verify with `test_db()` tests, including a case-insensitive duplicate, on both backends.
- [ ] 2.2 Implement argon2id hashing and verification in `spawn_blocking`, plus a startup dummy hash for constant-time misses (D5). Verify with unit tests: the hash is argon2id, the stored value doesn't contain the password, and the length rule (12–256) is enforced.
- [ ] 2.3 Add `clap` subcommands `user create|set-password|disable|enable|list`. Read passwords via `rpassword` on a TTY, or stdin otherwise, never argv. `set-password` and `disable` delete the user's sessions in the same transaction. Verify with tests that drive the command functions against `test_db()`, including a short password refused and sessions removed on disable.
- [ ] 2.4 Document operator account management in the README, with local and docker-compose examples. Verify that the documented commands run as written.

## 3. Sessions, login, and API protection

- [ ] 3.1 Add `ApiError` variants: `Unauthenticated`, `InvalidCredentials`, `Forbidden`, `NotFound`, `RevisionConflict`, `ProjectLimit`, and `TooManyRequests { retry_after }`, with their statuses and codes. Verify with error-shape unit tests (including the `Retry-After` header).
- [ ] 3.2 Implement sessions per D3: token generation, a sha256 hash stored, a sliding idle expiry bumped at most once per minute, a 30-day absolute cap, lazy deletion, and an hourly sweep. Verify with `test_db()` tests for an idle expiry and the absolute cap.
- [ ] 3.3 Implement `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, and `GET /api/v1/auth/me`, with cookie attributes per spec. Verify with integration tests for every `platform/accounts` Login, Sessions, and Current-user scenario: success, wrong password, an unknown email identical to a wrong password, a disabled account, HttpOnly/SameSite attributes, and logout invalidating the cookie.
- [ ] 3.4 Implement the in-memory login throttle (D6) with `Retry-After`. Verify with integration tests: 5 email failures give 429 even with the correct password, 20 IP failures, and success clearing the email count.
- [ ] 3.5 Add the auth `route_layer` and Origin check (D4) around all `/api/v1` routes except login and logout, and add PUT and DELETE to CORS. Verify with integration tests: generation without a session gives 401 and the mock provider is not called, instruments give 401, `/healthz` gives 200, and a cross-site Origin write gives 403.
- [ ] 3.6 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`. Verify that both pass.

## 4. Projects API

- [ ] 4.1 Implement a `projects` repository scoped by `owner_id` on every query. It covers list (summary columns only), create (server id, overwriting `song.id`, a 500-project limit), get, update with a revision check, and delete. Verify with `test_db()` tests for ownership isolation and the revision conflict (conditional `UPDATE`), on both backends.
- [ ] 4.2 Implement `/api/v1/projects` handlers: raw `Value` storage, validation via `Song::validate` (D2), `422` with the export error codes, and `400` for a missing `song`/`revision`. Add `/api/v1/projects` to the 2 MiB body-limit routes. Verify with integration tests for every `songs/project-storage` scenario, plus "Large project saved" and the unknown-field round trip.
- [ ] 4.3 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`. Verify that both pass.

## 5. Frontend authentication

- [ ] 5.1 Confirm the Next 16 `proxy.ts` conventions in `frontend/node_modules/next/dist/docs/`. Add `src/proxy.ts`, which redirects cookie-less page requests to `/login?next=<path>` and excludes `/login`, `/api`, `/_next`, and static assets. Verify with a Vitest unit test of the matcher and redirect logic.
- [ ] 5.2 Add the auth client (`login`, `logout`, `me`), `USER_MESSAGES` entries for the new codes, and `signOutLocally()`. `signOutLocally()` clears the `songbird.patterns.*` and `songbird.studio.lastSong*` keys and navigates to `/login?next=`. Make `request()` call it on `401 unauthenticated`. Verify with Vitest tests for the 401 path and the cleared keys.
- [ ] 5.3 Build the `/login` page: email, password, Sign in disabled while in flight, the incorrect-credentials and try-later messages, a sanitised `next`, and a redirect away when already signed in. Ask `ui-designer` for the layout first. Verify with Vitest tests for each Login page scenario.
- [ ] 5.4 Add an `AuthProvider` (`me` on load) and a header user menu with the email and Log out (flush pending save, then logout, `signOutLocally`). Verify with Vitest tests that log out calls flush then logout, and that the email is shown.

## 6. Frontend song library and per-user storage

- [ ] 6.1 Implement `createServerSongLibrary` with the existing `SongLibrary` interface over `/api/v1/projects` (D9). It covers revision tracking, the 300 ms debounce, retry with backoff, `status.failed`, and the new `status.conflict`. Make it the default from `getSongLibrary()`, and delete the IndexedDB implementation and `idb-keyval`. Verify with Vitest tests using mocked `fetch`: save sends the revision, a 409 sets conflict and stops autosave, and a network failure sets failed and retries.
- [ ] 6.2 Studio: render the conflict banner with "Reload" and "Save as copy", add a `beforeunload` warning while a save is pending, create a first song when the user has no projects, and use the per-user last-song key. Verify with `StudioPage` Vitest tests for each "Account song library" scenario.
- [ ] 6.3 Update `SendToSongButton`, `SongLibraryMenu`, and `SongFileActions`/Open project to the server library. Make import always get a server id and surface server `422` messages. Verify with their Vitest suites, including "Duplicate id kept separately".
- [ ] 6.4 Key the pattern store's persist name by user id, and create the store only after `me` resolves. Verify with Vitest tests: user B doesn't see user A's pattern, and logout removes the keys.
- [ ] 6.5 Run `pnpm lint`, `tsc`, and `pnpm build` in `frontend/`. Verify that all pass.

## 7. End-to-end and integration

- [ ] 7.1 Add `SONGBIRD_DATABASE_URL=sqlite://<tmp>/e2e.db` and `SONGBIRD_COOKIE_SECURE=false` to the Playwright backend `webServer` env. Add a `globalSetup` that deletes the e2e database file, seeds `e2e@example.com` via `api user create`, logs in, and saves `storageState` for all projects. Verify that the existing `studio`, `piano`, `drum-machine`, and `midi-recording` specs pass.
- [ ] 7.2 Add `e2e/auth.spec.ts` (no storage state). It covers: a visit to `/studio` redirects to login and returns after sign-in, a wrong password message, logout then Back not showing projects, two users not seeing each other's songs, and a session deleted mid-session sending the user to `/login`. Verify with `just test-e2e`.
- [ ] 7.3 Run `just lint` and `just test`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
