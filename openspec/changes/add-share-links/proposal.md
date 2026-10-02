# Proposal

## Why

A song in progress needs ears other than the writer's: a co-writer, a band, a producer. Today every project is visible only to its owner, and accounts are created by an operator, so the only way to let someone hear a song is to export a WAV and send it around. That loses the song's structure and lyrics, and the feedback comes back as "the bit about a minute in", detached from the song.

The browser can already play a song from its JSON document, including the offline mixdown renderer, so a read-only listen page can play a shared song without any audio being uploaded. This change lets an owner hand out a link, and lets listeners leave feedback pinned to a moment in the song that shows up in the Studio where the owner works.

**Depends on:**
- `add-vps-deployment` for real-world use. Its access gate puts HTTP basic auth in front of every request, so listeners can only reach a share link once the operator turns the gate off (accounts now exist). This change does not alter the gate; see design.md, open questions.

## What Changes

- **Share links**: the owner of a project can create share links from the Studio. Each link:
  - is an unguessable URL `/listen/<token>`, where the token is 256 bits from the OS random source and only its hash is stored;
  - is read-only, and can be revoked at any time;
  - can have an optional expiry;
  - is either **live** (always plays the project's latest saved version) or a **snapshot** (plays the song as it was when the link was created);
  - has owner toggles for listener comments and for MIDI/WAV downloads.
  
  A project can have up to 20 links, and the owner can list them, change their toggles and expiry, and revoke them.
- **Public listen page** `/listen/[token]`: needs no account. It plays the song with a section-aware timeline, shows the song's lyrics, and offers downloads only when the owner allowed them. It has no editing, no AI features, and no access to the owner's AI keys, other projects, or account. Revoked, expired, and unknown links all look the same.
- **Shared song projection**: what a listener receives is a public projection of the song. It drops the song chat, the lyric assistant conversation, and section notes, which are the owner's working material, not part of the song.
- **Listener comments**: a listener gives a display name and leaves a plain-text comment pinned to a position in the song and the section it falls in. Comments are private feedback: only the owner sees all of them; a listener sees only the ones they posted from that browser.
- **Comments in the Studio**: the owner sees comments as markers on the section ruler and in a comments panel, and can jump to, resolve, reopen, and delete them.
- **Abuse controls for anonymous input**: per-address and per-link rate limits on comment posting and on listen-page reads, a per-link comment cap, strict size and character rules on names and bodies, a honeypot field, and text-only rendering everywhere a comment appears.
- **Audio tracks**: imported samples and recordings live only in the owner's browser, so they are not available to listeners. The listen page plays every other track, marks audio tracks as unavailable, and the share dialog warns the owner before creating the link.
- **Platform changes**: the listen API and the listen page are the first public surfaces besides login and health checks. Authentication, the login redirect, request logging (share tokens must never be logged), and project ownership requirements gain explicit, narrow exceptions.

Non-goals:
- Uploading sample or recording audio to the server.
- Comment threads, replies, reactions, or email notifications.
- Listener accounts, or comments visible to other listeners.
- Collaborative editing through a link.
- Embedding the listen page in other sites (framing stays denied).
- Distributed rate limiting across several backend instances.

## Capabilities

### New Capabilities
- `songs/share-links`: share link creation, modes (live and snapshot), expiry, revocation, toggles, limits, token handling, the public listen API, the shared song projection, MIDI download, and the `/listen/[token]` page with playback, timeline, lyrics, and WAV download.
- `songs/listener-comments`: posting comments on a share link, validation and abuse controls, the owner's comment API, and comment markers and the comments panel in the Studio.

### Modified Capabilities
- `platform/accounts`: "Authentication required for the API" gains the public `/api/v1/listen/` routes as an exception, still under the origin check for writes. "Signed-out users are sent to login" exempts `/listen/` pages, and a `401` on those pages must not sign anyone out. "Signed-in user and log out in the app" keeps account details off listen pages.
- `platform/service-operations`: "Request logging protects credentials" adds share tokens to what logs must never contain.
- `songs/project-storage`: "Projects are owned by one user" allows read-only access through a valid share link. "Delete a project" also removes its share links and comments.

## Impact

- **Backend (`api` crate)**:
  - Migration `0004_share_links` in both `migrations/sqlite/` and `migrations/postgres/`, adding `share_links` and `share_comments` tables.
  - New modules: `share_store.rs`, `shares.rs` (owner routes under `/api/v1/projects/{id}/shares` and `/comments`), `listen.rs` (public routes under `/api/v1/listen/{token}`), and an in-memory `share_throttle.rs` modelled on `auth/throttle.rs`.
  - `routes.rs` gets a third router group, public but origin-checked. The trace span redacts the token segment of listen paths.
  - The projection and MIDI download reuse `music::Song` and the existing MIDI export.
- **Frontend**:
  - A new `app/listen/[token]` route outside the login redirect in `proxy.ts`, with its own API client that never triggers sign-out.
  - A read-only song view that reuses `useSongPlayback`, the section ruler, the lyrics renderer, and `renderMixdown`.
  - In the Studio, a Share dialog, comment markers on the section ruler, and a comments panel.
- **Data**: two new tables. Snapshots count toward the owner's 100 MiB stored-bytes quota. Song documents are unchanged.
- **Security**: new anonymous write surface. Rate limits are in memory and per instance, which matches the single-instance deployment but resets on restart.
- **Ops**: new optional environment variables for the comment and read limits, with safe defaults.
