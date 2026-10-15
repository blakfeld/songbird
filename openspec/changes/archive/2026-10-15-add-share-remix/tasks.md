# Tasks

## 1. Backend: schema

- [ ] 1.1 Add migration `0005_share_remix_usernames.sql` for sqlite and postgres. It adds `share_links.allow_remix BOOLEAN NOT NULL DEFAULT FALSE`, `users.username TEXT NULL` with a `UNIQUE` index, and `share_comments.author_id TEXT NULL REFERENCES users (id) ON DELETE CASCADE`. Verify the test harness in `tests/common/app.rs` applies it on both backends.

## 2. Backend: usernames

- [x] 2.1 Add username validation, store lowercased: 3–30 characters, `[a-z0-9_-]`, starting with a letter. Add `PUT /api/v1/account/username`, mapping a unique-index violation to `409 username_taken` and bad input to `422 invalid_username`. Add a per-user limit of 5 changes per hour, returning `429` with `Retry-After`. Verify with API tests for: set, change, same name, case-insensitive taken, invalid, concurrent claims, throttle, and `401` without a session.
- [x] 2.2 Return `username` (`null` when unset) from `GET /api/v1/auth/me`. Verify with an auth test for both cases.
- [x] 2.3 Extend the operator CLI in `src/cli.rs` and `src/users.rs`:
  - an optional username on create, with the same validation and taken check;
  - username in the account list;
  - the delete command's confirmation text mentions comments.

  Verify with CLI tests for create with a username, a taken username, and the list output. Update the operator docs in `deploy/README.md`.
- [x] 2.4 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`, and verify both pass.

## 3. Backend: `allow_remix` on share links

- [x] 3.1 Read and write `allow_remix` in `share_store`: create, update (`Option<bool>` means unchanged), list, and `find_active`. Verify with new cases in `tests/share_store.rs`.
- [x] 3.2 Add `allow_remix` to the create, PUT, and list DTOs and to the listen `share` object. Verify that:
  - `tests/shares_api.rs` covers default false, create true, PUT toggle, and that omitting it on PUT leaves it unchanged;
  - `tests/listen_api.rs` asserts the field in the `200` body.
- [x] 3.3 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`, and verify both pass.

## 4. Backend: session-bound listen actions

- [x] 4.1 Create `src/listen_actions.rs`, mounted behind the session layer and the listen per-IP throttle. Move the comment POST route there from `src/listen.rs`, leaving only the public GETs in `listen.rs`. Verify that `tests/listen_api.rs` still passes for GET and MIDI, and that a GET with a session cookie is unchanged.
- [x] 4.2 Change comment posting:
  - the body is `{body, at_step}` and unknown fields are refused, including `name` and `website`;
  - remove the honeypot path;
  - `author_name` is the user's current username and `author_id` is the user;
  - return `409 username_required` when the user has no username.

  Verify with tests for: `401` without a session, `username_required`, a `name` field refused with `422`, the stored name equal to the username, the owner's comment list containing no author id or email, and a cross-origin post refused with `403`.
- [x] 4.3 Re-key the comment limits in `share_throttle.rs` from address to user (`comments_per_user_10m`, `comments_per_user_day`). Rename the config environment variables, keeping the old names as a fallback. Verify with tests that the 6th comment in 10 minutes from one user gets `429`, and that a second user at the same address is unaffected. Document the renamed variables.
- [x] 4.4 Verify that comments are deleted with their author: deleting a commenter's account removes their comments on another user's project, and comments with a `NULL` author survive. Add the test in the share comments or user-delete test file.
- [x] 4.5 Extract the id-assign → `validated_facts` → `project_store::create` sequence from `src/projects.rs` into a shared helper. Verify `tests/projects.rs` still passes unchanged.
- [x] 4.6 Add a per-user remix throttle: 10 per minute by default, set by `SONGBIRD_REMIXES_PER_MINUTE`. Document it next to `SONGBIRD_SHARE_READS_PER_MINUTE`. Verify with a unit test that the 11th request in a minute is refused with a retry-after.
- [x] 4.7 Add `POST /api/v1/listen/{token}/remix` to `src/listen_actions.rs`. It:
  - returns `404 not_found` when the link is inactive or `allow_remix` is false;
  - ignores the request body;
  - names the copy `"<name> (remix)"`, truncated to the name limit;
  - creates the project with the shared helper and responds `201`.

  Verify with a new `tests/remix_api.rs` covering every scenario in `specs/songs/remix/spec.md` under "Remix API", "Remix contents", "The source project is untouched", and "Remix limits". That includes `401`, snapshot and live links, no chat or notes copied, no owner or project id, the source revision unchanged, `409 project_limit`, `429`, and a cross-origin request refused with `403`.
- [x] 4.8 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`, then the backend test suite. Verify all three pass.

## 5. Frontend: usernames and Profile

- [x] 5.1 Add `username` to the `AuthUser` type and `me()`. Add `setUsername()` to the account API client. Verify that TypeScript compiles and that a Vitest test covers the `409` and `422` mapping.
- [x] 5.2 Build a shared `UsernameForm` component. It validates the rules as the user types, shows the server's `username_taken` message, and disables saving while a request is in flight. Verify with Vitest tests for each rule message, the taken message, and the in-flight state.
- [x] 5.3 Add `app/settings/profile/page.tsx` with the email, the current username or "No username set", the form, and the note that usernames are shown to song owners on comments. Add "Profile" to the account menu. Verify with Vitest tests for the page and the menu entry.

## 6. Frontend: share dialog toggle

- [x] 6.1 Add `allow_remix` to the share link types and API calls. Verify that TypeScript compiles.
- [x] 6.2 Add an "Allow remixing" toggle to the Share dialog's create form and to each link's edit controls. It defaults to off and has an explanatory note. Show the remix status in the link list. Verify with Vitest tests for the default, creating a link with remixing on, and toggling an existing link.

## 7. Frontend: listen page

- [x] 7.1 In `lib/listen/api.ts`, add `remixShare(token)` and change `postComment` to send `{body, at_step}`. Both use `signOutOnUnauthenticated: false`. Verify with Vitest tests that a `401` doesn't trigger sign-out, and that `postComment` sends no `name` or `website`.
- [x] 7.2 In `components/listen/ListenPage.tsx`, probe `me()` with `signOutOnUnauthenticated: false` only when `allow_comments` or `allow_remix` is set. Share the result with the comment form and the Remix control. Verify with `ListenPage.test.tsx` that:
  - there is no probe when both are off;
  - a probe returning `401` doesn't sign out;
  - the existing "never signs anyone out" test still passes.
- [x] 7.3 Rework `CommentForm`:
  - "Sign in to comment" links to `/login?next=<encoded path>` when the visitor is signed out;
  - a note that a username is needed, linking to `/settings/profile`, appears when the visitor is signed in without a username (no inline username field);
  - "Commenting as <username>" replaces the name field;
  - a `401` keeps the text and switches to sign-in;
  - `username_required` keeps the text and shows the Profile link note;
  - remove the name memory and the honeypot field.

  Verify with Vitest cases for each state and response.
- [x] 7.4 Add the Remix control:
  - "Remix" when signed in, "Sign in to remix" when signed out, and nothing when `allow_remix` is false;
  - the audio-tracks notice;
  - disabled while the request is in flight;
  - on `201`, `window.location.assign("/?song=<id>")`;
  - messages for `project_limit`, `429`, `404`, and `401`.

  Verify with Vitest cases for each.
- [x] 7.5 Ask `ui-designer` to place the sign-in prompts, the username prompt, "Commenting as", and the Remix control so they fit with the listen page's existing download and comment layout, then apply the result. Verify that the page shows them without overflow at phone width.

## 8. End-to-end

- [x] 8.1 Extend `frontend/e2e/share-links.spec.ts` with a comment flow:
  1. The owner shares with comments on.
  2. A signed-out visitor sees "Sign in to comment" and signs in as a second user with no username.
  3. The second user sees the Profile link, sets a username on the Profile page, returns to the listen page, and posts a comment.
  4. The owner sees the comment under that username in the Studio.

  Verify that the Playwright spec passes.
- [x] 8.2 Extend `frontend/e2e/share-links.spec.ts` with a remix flow:
  1. The owner turns on remixing.
  2. The second user, signed out, sees "Sign in to remix", signs in, and returns to the listen page.
  3. They click "Remix" and land in the Studio with "<name> (remix)", then edit and save it.
  4. The owner's project is unchanged.
  5. When the owner turns remixing off, the button disappears.

  Verify that the Playwright spec passes.
- [x] 8.3 Run `openspec validate add-share-remix --strict` and verify it passes.
