# Design

## Context

Paths are relative to `backend/crates/api/` (backend) and `frontend/src/` (frontend).

**Song storage.** A song is one JSON document in one `projects` row (`migrations/*/0002_accounts.sql`), and there are no child tables. Sample and recording audio is never on the server. It lives in the owner's browser IndexedDB (`lib/audio/sampleStore.ts`), and the document holds only `sample_id` metadata.

**Share links.**
- **Lookup:** `share_store::find_active` (`src/share_store.rs:451-510`) resolves a token to an active link. It returns the song as the shared projection, with `chat`, `lyric_chat`, and section `notes` stripped, and with `song.id` replaced by the share id so the project id never leaks.
- **Routing:** the listen routes (`src/listen.rs`) sit outside the session layer and behind a per-IP throttle (`src/routes.rs:90-101`). The module never builds a `CurrentUser`.
- **Comments:** today `POST /api/v1/listen/{token}/comments` lives in `src/listen.rs` and is anonymous. It takes a typed `name` and a `website` honeypot. `share_comments.author_name` (`migrations/*/0004_share_links.sql`) stores that name. `share_throttle.rs` limits comments per address (`comments_per_address_10m`, `comments_per_address_day`) and per share.

**Accounts.** `users` has `id`, `email`, the password hash, `disabled`, and timestamps, but no display name. The operator CLI lives in `src/cli.rs` and `src/users.rs`.

**Creating projects.**
- `POST /api/v1/projects` (`src/projects.rs:81-98`) assigns `Uuid::now_v7`, overwrites `song.id`, validates with `validated_facts`, and calls `project_store::create`.
- `project_store::create` enforces the 500-project and 100 MiB limits under a per-owner lock in one transaction (`src/project_store.rs:149-170`).
- No server-side copy exists. The Studio's "save as copy" is client-side (`StudioPage.tsx:835-843`).

**Frontend.**
- **Session check:** `AuthProvider` deliberately skips `me()` on `/listen/*` (`components/auth/AuthProvider.tsx:23-24`), so the listen page currently doesn't know who is viewing.
- **Quiet 401s:** `lib/api.ts:115` already supports `signOutOnUnauthenticated: false`, which the login page uses to check for a session without triggering a sign-out.
- **Opening a song:** the Studio opens a song from `/?song=<id>` (`StudioPage.tsx:231-236`).
- **Settings pages:** these live under `app/settings/` (today only `ai-keys`).

## Goals / Non-Goals

**Goals:**
- Build the copy on the server from the same projection the listener sees, so it can't include more than the listen page shows and can't be forged by the client.
- Reuse the existing project-creation path, so remixes get the same limits, validation, and concurrency guarantees.
- Keep the listen page safe for stale or missing sessions.
- Make every new comment attributable to an account, while showing the owner only a username the commenter chose.

**Non-Goals:**
- Copying sample or recording audio. There is no server-side audio to copy.
- Recording lineage ("remixed from …"), notifying the owner, or showing remix counts. Any of these would need a schema change and a privacy decision of its own.
- Remixing from the Studio's own share dialog, or bulk or automated remixing.
- Public profiles, avatars, or showing usernames anywhere other than comments and the visitor's own Profile and listen page.
- Letting listeners edit or delete their own comments after posting.

## Decisions

### Session-bound listen actions in their own module
The remix and comment POST handlers move into a new module, `src/listen_actions.rs`. It is mounted in the **session-protected** router so both handlers get `CurrentUser` and the standard `401`, and it is also wrapped in the listen per-IP throttle. The public GET routes stay in `src/listen.rs` outside the session layer, which keeps that module's "never builds a CurrentUser" property true. Splitting the routes by session requirement, rather than checking for a session inside each handler, means a missing session can never fall through to a handler that forgot to check.

### Server-side remix at `POST /api/v1/listen/{token}/remix`
The endpoint resolves the token with `find_active` and checks `allow_remix`. It then follows the `POST /api/v1/projects` path: new UUID, overwrite `song.id`, rename, validate, and `project_store::create`.

*Alternatives considered:*
- **The client fetches the listen song and calls `POST /api/v1/projects`.** This needs no backend work, but the owner's `allow_remix` would then be enforced only in the UI. Anyone could copy any shared song regardless of the setting, so it was rejected.
- **`POST /api/v1/projects` with a `{"from_share": token}` body.** This mixes two request shapes into one endpoint. Keeping the token in the path matches `/listen/{token}/midi` and `/comments`.

### Refactor creation into a shared helper
The id assignment, `validated_facts`, and `store::create` sequence in `src/projects.rs` is extracted into one function that both handlers call. That way limits and validation cannot drift between them. Error mapping (`ProjectError::Limit` → `409 project_limit`) is reused unchanged.

### Remix name
The name is `"{name} (remix)"`. If that would exceed the song-name length limit enforced by validation, the base name is truncated on a character boundary first. This matches the existing "(copy)" convention in `StudioPage.tsx`.

### Migration `0005_share_remix_usernames.sql` (sqlite and postgres)
- `share_links.allow_remix BOOLEAN NOT NULL DEFAULT FALSE`. Existing links therefore stay non-remixable, and owners opt in per link.
- `users.username TEXT NULL`, with a `UNIQUE` index. The server lowercases usernames before storing them, so a plain unique index enforces case-insensitive uniqueness on both databases without a functional index. Both databases allow many `NULL`s in a unique index, so existing accounts are fine. Concurrent claims are settled by the index: the loser's unique violation maps to `409 username_taken`.
- `share_comments.author_id TEXT NULL REFERENCES users (id) ON DELETE CASCADE`. It is nullable because rows from before this change have no author. The cascade implements "comments deleted with their author" with no extra code in the account-delete path. `author_name` stays and is filled from the username at posting time.

### `allow_remix` in the DTOs The create DTO accepts an optional `allow_remix` (default `false`). On `PUT`, `Option<bool>` means "unchanged when omitted", so existing clients that send only the old fields don't silently turn it off.

### `404` when remixing is off
`allow_remix == false` returns the same `not_found` as a dead token. This mirrors how `/midi` treats `allow_downloads == false`, and the listen page never offers the button in that case anyway.

### Per-user remix throttle
A small in-memory per-user limiter, default 10 per minute, set by the environment variable `SONGBIRD_REMIXES_PER_MINUTE`. It follows the shape of `share_throttle.rs` but is keyed on user id. The per-IP listen throttle alone doesn't stop one account behind many addresses from filling its quota-limited but costly create path.

### Username copied into each comment, not looked up live
A comment stores the username as it was at posting time (`author_name`), rather than joining to `users` when the comments are read. This has three benefits:
- Old anonymous comments and new signed-in ones read the same way.
- The owner's comment list never needs a join that could leak other account fields.
- A username change can't rewrite what someone appeared to say earlier.

The cost is that renamed users' old comments show their old name, which the spec accepts.

### Comment request shape and honeypot removal
The body becomes `{body, at_step}`, with unknown fields refused. A client still sending `name` therefore gets a clear `422` rather than having its value silently ignored. The `website` honeypot goes, because it only caught bots posting without accounts, and that is no longer possible.

### Per-user comment limits
In `share_throttle.rs`, the per-address comment buckets are re-keyed on user id, as `comments_per_user_10m` and `comments_per_user_day`. The per-share bucket is unchanged. The comment environment variables are renamed to match, and the old names are still read as a fallback for one release so deployed configuration keeps working. Keying on the account rather than the address is what makes per-person limits real: several people behind one NAT no longer share a budget, and one person behind many addresses no longer escapes it.

### Username API and throttle
`PUT /api/v1/account/username` sits next to the AI-keys routes under `/api/v1/account/`. Changes are limited per user, by default to 5 per hour, with an in-memory limiter like the remix one. The limit stops a user from cycling through names to impersonate other commenters in quick succession. `me` adds `username` to its response.

### Profile page and a shared username form
The Profile page is a new `app/settings/profile/page.tsx`, linked from the account menu next to AI keys. Its username form is a component of its own. The listen page does not render it: a signed-in commenter with no username gets a link to the Profile page instead, which keeps the comment section small and leaves Profile as the one place a username is set. The rules and error messages therefore live in one place. Client-side validation mirrors the server's rules for fast feedback, but the server remains authoritative.

### Listen-page session probe
`ListenPage` calls `me()` with `signOutOnUnauthenticated: false` after the share loads, and only when `share.allow_comments` or `share.allow_remix` is true. That keeps the probe off links where it can't matter. `AuthProvider` keeps skipping `/listen/*`. The probe is local to the page and doesn't call `setCurrentUserId`, because the page reads no per-user storage.

| Probe result | Page shows |
|---|---|
| `401` | "Sign in to remix" / "Sign in to comment" |
| Network or other error | "Sign in to remix" / "Sign in to comment" |
| `200` | "Remix" and the comment form, or a link to the Profile page if `username` is `null` |

The remix, comment, and username calls from the listen page also pass `signOutOnUnauthenticated: false`. If the session expires between the probe and an action, the `401` switches that control back to its sign-in link, and the comment text is kept.

### Navigation after remix
On `201`, the page does a full navigation: `window.location.assign("/?song=<id>")`. A full load runs `AuthProvider` fresh with a real `me()` and per-user storage set up for the signed-in user. That is safer than a client-side push from a page that bypassed `AuthProvider`.

### Sign-in return
"Sign in to remix" and "Sign in to comment" link to `/login?next=<encoded /listen/<token>>`. The login page's same-origin return logic already accepts this. No auto-remix happens on return, so a crafted link can't make a signed-in user create projects without clicking.

## Risks / Trade-offs

- **[Risk] Audio tracks arrive silent in the remix.** → The listen page warns before remixing. The Studio's existing missing-sample handling shows the gap, and the remixer can import their own audio.
- **[Risk] The share token appears in the `/login?next=` URL.** → The token is already in the listen page URL and history, so this adds no new exposure. Login and listen pages are `noindex`.
- **[Risk] A live link's owner later regrets enabling remix.** → Turning it off stops future remixes. Copies already made are the remixer's, and this is stated in the dialog copy.
- **[Trade-off] No lineage.** A remix can't link back to its source. This is accepted for privacy: storing the source would tie two users together. It can be added later as its own change.
- **[Risk] A remix gives a near-complete song to any signed-in user with the link.** → The setting is off by default, per link, and revocable.
- **[Trade-off] Anonymous listeners can no longer comment.** Accounts are operator-created, so an owner who shares with people who have no account loses their feedback. This is accepted by the change's intent. Listening, downloads, and the song itself remain open to anyone with the link.
- **[Risk] Usernames could impersonate.** A user could choose a name like another person's. → Names are unique, changes are throttled, and comments are visible only to the owner, who knows whom they shared with. Reserved names are not needed while there are no public profiles.
- **[Risk] Breaking the comment API.** → The frontend and backend deploy together as one Fly Machine, so no older client stays live after the deploy.

## Migration Plan

1. Deploy the backend and frontend together, as the single Fly Machine already does. Migration `0005` runs at startup.
   - `allow_remix` defaults to `false`, so existing links behave as before, except that commenting now requires sign-in.
   - Existing accounts have no username until they set one.
   - Existing comments keep their names and have a `NULL` author.
2. Operators who set the comment-limit environment variables should rename them. The old names are honoured for one release.
3. **Rollback:** redeploy the previous image. The new columns are harmless to the old code. Comments posted after the upgrade remain readable by the old code, because `author_name` is always filled.
