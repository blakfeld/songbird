# Proposal

## Why

Songbird is single-user today. Every song lives in one browser's IndexedDB, and every API endpoint, including the paid AI endpoints, is open to anyone who can reach the server. Before more than one person can use it, songs need an owner, a person needs to sign in to reach them, and the server needs to refuse everyone else.

## What Changes

- **User accounts.** Using the database layer from `add-database-foundation` (SQLite in development, provider-managed Postgres with the provider's automated backups in production), the backend gets a `users` table (email, argon2id password hash, disabled flag). An operator creates, disables, resets, and deletes accounts from a CLI. Deleting an account removes its projects and sessions. There is no public sign-up.
- **Login and sessions.** `POST /api/v1/auth/login` checks email and password and sets an HttpOnly session cookie (`__Host-songbird_session` over https), always with a fresh token. `POST /api/v1/auth/logout` ends the session, and `GET /api/v1/auth/me` returns the signed-in user. Sessions expire. Disabling a user or resetting their password ends all of their sessions. Repeated failed logins are throttled per email and address, with only a slowdown (never a lockout) per email across addresses. Password hashing runs under a small concurrency limit, so a login burst cannot exhaust the server.
- **Everything requires a session.** Every `/api/v1` endpoint except login and logout returns `401 unauthenticated` without a valid session. That includes generation, chat, export, and instruments. `/healthz` and `/readyz` stay public. Writes, including login and logout, are refused from origins that aren't configured. API responses are never cached.
- **Kicked out.** Every page except `/login` sends a visitor without a session to `/login`, and returns them to where they were after they sign in. If the session stops being valid while the app is open (it expired, it was logged out elsewhere, or the user was disabled), the next API call gets `401`. The app then clears per-user browser state and sends the user to `/login`.
- **Login page.** A new `/login` page has email and password fields. The app header shows who is signed in and has a Log out control.
- **Projects owned by users.** Songs ("projects") move from browser IndexedDB to the server. New `/api/v1/projects` endpoints let the signed-in user list, create, read, save, and delete only their own projects. Another user's project is indistinguishable from one that doesn't exist (`404`). The Studio's song library, Send to song, and Open project use these endpoints. **BREAKING:** songs saved in a browser's local library are not migrated. They are left where they are and no longer shown.
- **Scratch patterns stay local, per user.** The single-instrument editor pages keep their pattern in browser storage, but keyed by user, and it is cleared on logout.
- **Abuse limits.** Each user gets a per-minute rate limit and a daily quota on the paid AI endpoints, a cap on project count and stored bytes, and at most one save per project per second.
- **Hardening.** Security headers (CSP, no framing, `nosniff`, same-origin referrer) are set from the Next config. Passwords and session tokens never reach logs, and request logs carry the user id, never the email. Per-user browser storage is cleared on sign-out through one registry that every new store must join.
- **Ops.** New config: cookie `Secure` flag, session lifetime, trusted proxy, and the AI limits. The service refuses to start with a non-`Secure` cookie and an https origin, and warns when it looks deployed but doesn't trust its proxy. The accounts tables are added as migrations to both the SQLite and the Postgres migration sets. **Depends on `add-database-foundation`**, which must merge first.

## Capabilities

### New Capabilities
- `platform/accounts`: user accounts, the operator CLI, login, logout, sessions, login throttling, authentication on every API endpoint, the login page, and sending signed-out users to it.
- `songs/project-storage`: server-side storage of songs as projects owned by a user, and the `/api/v1/projects` API that enforces that ownership.

### Modified Capabilities
- `songs/multitrack`: the "Browser song library" requirement is replaced by an account song library backed by `songs/project-storage`.
- `songs/export`: Open project adds the imported song to the user's server-side library instead of the browser library.
- `patterns/piano-roll-editor`: scratch patterns are kept per user in the browser and cleared on logout.
- `platform/service-operations`: session, proxy-trust, and AI-limit configuration with startup guards; the 2 MiB body limit extended to `/api/v1/projects`; per-user AI limits; security response headers; and credential-safe request logging.

## Impact

- **Backend:** new dependencies: `argon2`, `rand`, `sha2`, `axum-extra` cookies, `clap`, and `rpassword`. Database access goes through the `Db` layer from `add-database-foundation`. New `auth` and `projects` modules, and migrations `0002_accounts.sql` for both backends, in `backend/crates/api`. `ApiError` gains `unauthenticated` (401), `forbidden` (403), `not_found` for projects, `revision_conflict` and `project_limit` (409), `id_mismatch` (422), `too_many_requests` (429), and `server_busy` (503). An auth layer wraps all `/api/v1` routes, and a metering layer wraps the AI routes. A `user` subcommand is added to the api binary. `Config` gains new vars, and the config-documentation test is updated.
- **Frontend:** new `/login` page. A Next 16 `proxy.ts` sends signed-out visitors to `/login`. The `lib/api.ts` 401 handler signs the user out locally. `lib/song/songLibrary.ts` is reimplemented over `/api/v1/projects`, and its IndexedDB use is removed. `patternStore.ts` keys become per user, and a per-user store registry drives sign-out clearing. `next.config.ts` gains security headers. A user menu with Log out is added.
- **Tests:** backend integration tests use the foundation's per-test databases plus a new authenticated request helper, and run on SQLite and Postgres in CI. They include cross-user access on every project method, bounded parallel logins, and a check that no log line contains a password or session token. Playwright needs a fresh SQLite database, a seeded test user, and a logged-in storage state. Vitest library tests switch from fake-indexeddb to a mocked API.
- **Infra:** the env example and README. Database infrastructure comes from `add-database-foundation`, and production hosting from `add-vps-deployment`.
