# Proposal

## Why

A listener who has a Songbird account can hear a shared song but can't build on it. Today the only way to get the song into their own Studio is to ask the owner for a project file. A "Remix" action turns a share link into a starting point. The owner decides whether a link allows it, and the original project is never touched.

Anonymous comments on share links have the opposite problem. They can be posted by anyone holding a link, under any name. That leaves the owner no idea who said what, and limits can only be applied per address. Requiring sign-in, with a username the commenter chooses, makes feedback attributable and lets limits follow the person.

## What Changes

### Remix
- Share links gain an `allow_remix` setting. It is off by default and shown as an "Allow remixing" toggle in the Studio's Share dialog. The owner can change it on a live link at any time, the same way as comments and downloads.
- New endpoint `POST /api/v1/listen/{token}/remix`, which requires a session. When the link is active and allows remixing, it creates a new project owned by the signed-in user from the link's **shared song projection**: no song chat, no lyric conversation, and no section notes. The new project gets a fresh id and is named "<song name> (remix)". It counts toward the user's normal project and storage limits. The source project, its share links, and its comments are never read beyond the projection and are never written.
- The listen page shows the Remix control only when the link allows remixing:

  | Visitor | Control shown |
  |---|---|
  | Signed in | "Remix" button. On success it opens the Studio at `/?song=<new id>`. |
  | Signed out | "Sign in to remix" link, which goes to `/login` and returns to the same listen page. |

- Audio tracks are copied as they appear in the projection: track, clip, and sample metadata only. Sample audio lives only in the owner's browser, so the listen page warns before remixing that audio tracks will arrive without their audio.

### Usernames
- Accounts gain an optional, unique `username`. It is case-insensitive, 3–30 characters, uses lowercase letters, digits, `_`, and `-`, and starts with a letter.
- `PUT /api/v1/account/username` sets or changes it, and `GET /api/v1/auth/me` returns it, or `null` when none is set.
- A Profile page reachable from the user menu lets the user set or change it.
- The operator's create-account command accepts an optional username, and the account list shows it.

### Signed-in comments
- **BREAKING (API):** `POST /api/v1/listen/{token}/comments` requires a session. It responds `401` without one, and `409 username_required` when the user has no username yet.
- **BREAKING (API):** the comment body loses its `name` and `website` (honeypot) fields. The comment's name is the commenter's username at the time of posting.
- Comment rate limits apply per user instead of per address.
- The server records the commenting account but never shows its id or email to the owner.
- Deleting an account deletes the comments it wrote on other people's songs.
- Comments posted before this change keep their typed names.
- The listen page shows the comment form to signed-in users with a username:

  | Visitor | Page shows |
  |---|---|
  | Signed out | "Sign in to comment" |
  | Signed in, no username | A note that a username is needed, linking to the Profile page |
  | Signed in, with a username | The form, without a name field, saying "Commenting as <username>" |

### Listen page and sessions
- The listen page quietly checks whether the visitor is signed in when the link allows comments or remixing. It still renders the song the same way with or without a session, and it never signs anyone out, clears browser storage, or redirects on its own.
- The listen page may show the visitor's own username, but still never their email or a Log out control.
- The remix and comment endpoints are the listen endpoints that require a session. The read endpoints still ignore sessions.

## Capabilities

### New Capabilities
- `songs/remix`: creating your own copy of a shared song from a share link. Covers the remix API, what is and isn't copied, limits, and the Remix control on the listen page.

### Modified Capabilities
- `songs/share-links`:
  - creating and managing links gain `allow_remix`;
  - the public listen API reports it;
  - the listen page checks for a session and shows the sign-in prompts;
  - the Share dialog gains the "Allow remixing" toggle.
- `songs/listener-comments`:
  - posting requires a session and a username;
  - the `name` and honeypot fields are removed;
  - limits apply per user;
  - the comment form changes;
  - comments are deleted with their author's account.
- `platform/accounts`:
  - accounts gain usernames, with an API, a Profile page, and operator command support;
  - `/auth/me` returns the username;
  - the remix and comment listen endpoints require a session;
  - the listen page may check for a session and show the visitor's username.

## Impact

### Backend (`backend/crates/api`)
- Migration `0005`, for sqlite and postgres, adding:
  - `share_links.allow_remix`;
  - `users.username` with a case-insensitive unique index;
  - `share_comments.author_id`, a nullable reference to `users` that is cascade-deleted.
- `share_store` and the share DTOs carry `allow_remix`.
- New remix handler behind the session layer, reusing `project_store::create`.
- The comment handler moves behind the session layer, with a per-user throttle.
- New username endpoint, and `me` returns the username.
- Operator CLI changes for usernames.
- Tests in `tests/remix_api.rs` (new), `tests/listen_api.rs`, `tests/shares_api.rs`, and the auth and CLI tests.

### Frontend (`frontend/src`)
- The listen page gets the session probe, the Remix control, and the signed-in comment form with a link to set a username on the Profile page.
- `lib/listen/api.ts` gets the remix and comment calls.
- New Profile page and user-menu entry.
- The Share dialog gets the toggle.
- Vitest tests for all of the above, and Playwright flows in `e2e/share-links.spec.ts`.

### Compatibility
Anonymous comment posting stops working when this ships. Older frontends will get `401` on comment posts until they are updated, which is acceptable because both deploy together as one Fly Machine.
