# Tasks

## 1. Data model and store (backend)

- [ ] 1.1 Add `migrations/sqlite/0004_share_links.sql` and `migrations/postgres/0004_share_links.sql` with `share_links` and `share_comments` as in design D2, following `src/db/README.md` for types, cascades, and indexes. Verify that `cargo test -p api` passes, including the test that the two directories match, and that `just test-backend-pg` applies the Postgres file.
- [ ] 1.2 Extract token generation and `sha256_hex` from `auth/session.rs` into a shared token module (D1), and switch sessions to it. Verify that the existing session tests pass unchanged.
- [ ] 1.3 Implement `share_store.rs`: create (with snapshot and quota check under `lock_owner`, D11), list with status and unresolved count, update, revoke (nulling the snapshot), lookup by token hash returning only active links, and comment insert with the 1,000 cap, list, resolve or reopen, and delete. Scope every owner query by `owner_id`. Verify with store tests on SQLite for:
  - the 20-link limit;
  - snapshot bytes counting toward the 100 MiB quota and being freed on revoke;
  - expired and revoked links not being found by token;
  - user B's ids being `NotFound` for every owner operation;
  - project and user deletion cascading to links and comments.
- [ ] 1.4 Extend the stored-bytes quota in `project_store.rs` to include `share_links.snapshot_bytes` (D11). Verify with a test that a project save is refused with `project_limit` when snapshots fill the quota.
- [ ] 1.5 Implement the shared song projection (D4) that removes `chat`, `lyric_chat`, and `sections[].notes` from the JSON value, and add the `Song` field-classification test. Verify with tests that the projection removes exactly those fields and keeps unknown fields, and that adding an unclassified field to `Song` fails the classification test.
- [ ] 1.6 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 2. Owner share and comment API (backend)

- [ ] 2.1 Add `shares.rs` with `POST`/`GET /api/v1/projects/{id}/shares` and `PUT`/`DELETE /api/v1/projects/{id}/shares/{share_id}` in the `protected` group. Add `invalid_share` (422) and `share_limit` (409) to `ApiError`. Verify with integration tests for every scenario in the `songs/share-links` requirements "Share link tokens", "Creating a share link", and "Managing share links", including that the token appears only in the create response.
- [ ] 2.2 Add `GET /api/v1/projects/{id}/comments` and `PUT`/`DELETE /api/v1/projects/{id}/comments/{comment_id}`. Verify with integration tests for every scenario in "Owner comment API", including another user's comment getting `404`.
- [ ] 2.3 Add tests for the modified `songs/project-storage` scenarios ("Shared project still invisible through the project API", "Delete a shared project"), and verify that they pass.
- [ ] 2.4 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 3. Public listen API and abuse controls (backend)

- [ ] 3.1 Implement `share_throttle.rs` (D7) with read, per-address comment, and per-share comment windows and periodic sweeps, configured from the four `SONGBIRD_*` variables with defaults in `config.rs`. Document the variables where the other `SONGBIRD_*` variables are documented. Verify with unit tests that use a shrunken clock for each window and for sweeping.
- [ ] 3.2 Add `listen.rs` with `GET /api/v1/listen/{token}` (song projection, `instruments` subset per D5, `share` and `shared_at`), and add the `listen` router group in `routes.rs` with `check_origin` and the throttle, and without `require_session` (D3). Verify with integration tests for every scenario in "Public listen API", "Shared song projection", and "Listen API abuse limits", and for the modified `platform/accounts` scenarios "Listen endpoint is public" and "Listen prefix does not open other routes".
- [ ] 3.3 Add `GET /api/v1/listen/{token}/midi`, reusing `song_to_midi` and the Studio export's file name rules. Verify with integration tests that downloads allowed returns a MIDI file that parses, and that downloads off returns `404`.
- [ ] 3.4 Add `POST /api/v1/listen/{token}/comments` with an 8 KiB body limit, `deny_unknown_fields`, the validation rules, the honeypot, server-side section resolution (D6), `project_revision` for live links, and throttle counting before validation. Add `invalid_comment` (422) and `comment_limit` (409). Verify with integration tests for every scenario in "Posting a comment", "Comment validation", and "Comment rate limits and caps", and for "Cross-site comment refused".
- [ ] 3.5 Add `redacted_path` to the trace span (D8) and make sure no share handler logs tokens or comment text. Verify with log-capture tests for the `platform/service-operations` scenarios "Share token not logged" and "Created token not logged".
- [ ] 3.6 Log a startup warning when deployment mode is production and `trust_proxy` is off, because the share throttle would then put every listener in one bucket. Verify with a startup test that captures the warning.
- [ ] 3.7 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass. Run `just gen-types` if any ts-rs types were added, and verify that the generated files are committed.

## 4. Listen page (frontend)

- [ ] 4.1 Exclude `listen` in `proxy.ts`'s matcher, and add `X-Robots-Tag: noindex, nofollow` for `/listen/:path*` in the Next config headers. Verify with `proxy.test.ts` cases for `/listen/abc` with and without a cookie, and a `securityHeaders` test for the robots header.
- [ ] 4.2 Add `lib/listen/api.ts`, a fetch wrapper that never calls sign-out, with typed `getShare`, `postComment`, and `midiUrl`. Verify with Vitest that a `401` or `404` response neither calls `signOut` nor touches `songbird.` storage.
- [ ] 4.3 Build `app/listen/[token]/page.tsx`: a read-only `SongStore` from the served song, `useSongPlayback` with the served instruments, a read-only section ruler with click-to-seek, the current section name, read-only lyrics, and the "This link isn't available" and rate-limited states. Audio tracks are shown as unavailable with the notice, and the sample store is never read. No account UI. Verify with component tests for each scenario in "Listen page" and "Audio tracks on the listen page", and for "No account shown on a listen page".
- [ ] 4.4 Add "Download MIDI" and "Download WAV" (via `renderMixdown` without audio tracks), shown only when `allow_downloads` is true. Verify with component tests for "Downloads hidden", and a test that the WAV path makes no network request for audio.
- [ ] 4.5 Add the comment form: name remembered under `songbird-listen.<tokenPrefix>.`, position pinned to the playhead and movable from the timeline, client-side limits, server messages, text kept on `429`, and "Your comments" from local storage. Render all comment text as plain text. Verify with component tests for "Pin to playhead", "Rate limited", "Own comments shown", and "Another listener cannot read comments", and a test that `<script>` text renders literally.
- [ ] 4.6 Add a Vitest check that no file under `app/listen/`, `components/listen/`, or the comment components uses `dangerouslySetInnerHTML`, and verify that it passes.
- [ ] 4.7 Run `just lint` and the frontend unit tests, and verify that both pass.

## 5. Studio share dialog and comments (frontend)

- [ ] 5.1 Add the "Share" action and dialog (create with defaults, copy-once URL note, list with status and unresolved counts, toggle and expiry edits, revoke with confirmation, audio-track warning, downloads explanation from D10), hidden for projects never saved to the server. Verify with component tests for "Create and copy", "Revoke from the dialog", and "Owner warned".
- [ ] 5.2 Add the comments panel and unresolved badge: fetch on project open, on panel open, and on "Refresh"; list unresolved first; "Show resolved"; resolve, reopen, delete with confirmation, and jump. Verify with component tests for "Resolve a comment" and "Undo unaffected", and that comment text is rendered as plain text and URLs are not links.
- [ ] 5.3 Add comment markers on the section ruler, with end-clamping and the "no longer in the song" flag; selecting a marker moves the playhead and opens the comment. Verify with component tests for "Marker opens the comment" and "Resolved marker hidden".
- [ ] 5.4 Run `just lint` and the frontend unit tests, and verify that both pass.

## 6. End-to-end and security checks

- [ ] 6.1 Add a Playwright test for the whole loop: the owner creates a live link, a fresh browser context without a cookie opens it, plays it, and posts a comment, then the owner sees the marker, resolves it, and revokes the link, and the listener's reload shows "This link isn't available". Verify that it passes with `just test-e2e`.
- [ ] 6.2 Run the `security-researcher` agent on the branch with focus on the listen routes, the comment input, logging, and the projection, and resolve or record every finding. Verify by attaching the findings summary to the PR description.
- [ ] 6.3 Note the access-gate dependency in the deployment docs owned by `add-vps-deployment`: share links need the gate off, or `/listen` and `/api/v1/listen` exempted. Verify that the note is present in that change's docs, or that an issue is filed if that change has already shipped.
