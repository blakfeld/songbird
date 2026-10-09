# Design

## Context

See proposal.md for the motivation. The pieces this change builds on:

**Backend (`backend/crates/api`):**
- `routes.rs` builds two router groups. `protected` (patterns, songs, projects, keys, AI) sits behind `require_session` and then `check_origin`. `public_auth` (login, logout) sits behind `check_origin` only. `middleware()` adds the body limit, `no_store`, CORS for the configured origins (GET/POST/PUT/DELETE only), and a `TraceLayer` whose span records `request.uri().path()`.
- `projects.rs` and `project_store.rs`: every query is scoped by `owner_id`, and someone else's project is indistinguishable from a missing one. Quotas are `MAX_PROJECTS_PER_USER` (500) and `MAX_STORED_BYTES_PER_USER` (100 MiB, summed from `projects.size_bytes`). Concurrent writes for one user are serialised by `lock_owner`, which touches the user's row.
- `auth/session.rs` already generates 32-byte tokens, encodes them as unpadded base64url, and stores only `sha256_hex` of them.
- `auth/throttle.rs` is an in-memory sliding-window throttle with periodic sweeps, justified by the single-instance deployment. `auth/http.rs::client_address` resolves the client IP, honouring `X-Forwarded-For` only when `config.trust_proxy` is set.
- Migrations live in `migrations/sqlite/` and `migrations/postgres/`, currently up to `0003_user_api_keys`. `src/db/README.md` sets the portability rules: TEXT UUIDv7 ids, `i64` ms times from Rust, booleans as INTEGER/BOOLEAN, JSON as TEXT, `$n` placeholders, and matching `(version, description)` pairs, which a unit test enforces.
- `music::song_midi::song_to_midi` produces the Studio's song MIDI from a `ValidSong`. `Song` has `chat`, `lyric_chat`, and section `notes` as optional fields.

**Frontend (`frontend/src`):**
- `proxy.ts` redirects every page without a session cookie to `/login`. Its matcher already excludes `login`, `api`, `_next`, health, and dotted paths.
- `lib/api.ts` signs the user out on any `401`.
- `useSongPlayback(store, instruments, loop)` and `createSongPlaybackModel` play a song from a `SongStore`. `renderMixdown` renders WAV offline. `useInstruments` fetches `/api/v1/instruments`, which needs a session.
- Sample and recording audio live only in per-user IndexedDB (`lib/audio/sampleStore.ts`, `songbird-samples.<userId>`).
- `lib/securityHeaders.ts` sets a self-only CSP, `frame-ancestors 'none'`, and `Referrer-Policy: same-origin`.

**In-flight:** `add-vps-deployment` puts a basic-auth access gate on every request except `/healthz`, enabled by default.

## Goals / Non-Goals

**Goals:**
- A share token is the only key to a shared song, and holding it gives nothing beyond that song's public projection.
- Anonymous comment posting is cheap to refuse and expensive to abuse, and cannot inject markup anywhere.
- Owner-side code reuses the existing ownership-scoped store patterns, so a share or comment of user A is invisible to user B exactly as projects are.
- The listen page reuses the Studio's playback, ruler, lyrics, and mixdown code instead of forking it.

**Non-Goals:**
- Server-side audio storage. Audio tracks are silent on the listen page.
- Realtime comment delivery (websocket or SSE). The Studio fetches on demand.
- Shared or distributed rate-limit state.

## Decisions

### D1. Token format and storage mirror sessions
Tokens are 32 bytes from the OS CSPRNG, base64url without padding (43 characters). The server stores `sha256_hex(token)` in a unique index and looks links up by hash. The token generation and hashing helpers are extracted from `auth/session.rs` into a small shared module, so both sessions and shares use one implementation.

Hashing means a database leak cannot be turned into working links, and lookups are already constant-time with respect to the token, because the comparison happens on a hash inside an index.

The consequence is that the owner sees the URL only once. The list shows a 6-character prefix (stored in plain text; 36 bits is useless to an attacker against a 256-bit space) so the owner can tell links apart. To recover a lost URL, the owner creates a new link and revokes the old one.

*Alternatives:*
- Storing the token in plain text so the owner can re-copy it. Rejected: it turns any read of the database or a backup into working public links.
- Encrypting it with the user-API-key master key. Rejected for now: it couples share links to key-encryption availability (`api_keys_unavailable`) and to master-key rotation, for a convenience. See open questions.

### D2. Schema (migration `0004_share_links`, both backends)
```
share_links(
  id TEXT PK,                       -- UUIDv7
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  mode TEXT NOT NULL,               -- 'live' | 'snapshot'
  label TEXT NOT NULL DEFAULT '',
  snapshot TEXT NULL,               -- projected song JSON, snapshot mode only
  snapshot_bytes INTEGER/BIGINT NOT NULL DEFAULT 0,
  allow_comments INTEGER/BOOLEAN NOT NULL,
  allow_downloads INTEGER/BOOLEAN NOT NULL,
  expires_at INTEGER/BIGINT NULL,
  revoked_at INTEGER/BIGINT NULL,
  created_at, updated_at INTEGER/BIGINT NOT NULL)
INDEX share_links_project (project_id, created_at)

share_comments(
  id TEXT PK,
  share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  at_step INTEGER NOT NULL,
  section_id TEXT NULL, section_name TEXT NULL,
  project_revision INTEGER/BIGINT NULL,
  created_at INTEGER/BIGINT NOT NULL,
  resolved_at INTEGER/BIGINT NULL)
INDEX share_comments_project (project_id, at_step)
INDEX share_comments_share (share_id, created_at)
```
`owner_id` and `project_id` are denormalised so owner queries filter with `owner_id = $n` exactly like `project_store`. Comments are keyed by `project_id` so the Studio needs one query. Cascades on both foreign keys implement "deleted with its project/user" without application code. SQLite enforces them because every connection enables `PRAGMA foreign_keys`.

Revocation sets `revoked_at`, nulls `snapshot`, and zeroes `snapshot_bytes`. This frees quota while keeping the row for its comments.

### D3. Three router groups; listen routes are public but origin-checked
`routes.rs` gains a `listen` group, merged beside `public_auth`:
- `GET /api/v1/listen/{token}`
- `GET /api/v1/listen/{token}/midi`
- `POST /api/v1/listen/{token}/comments`, with `DefaultBodyLimit::max(8 KiB)`

It is layered with `check_origin`, so a third-party page cannot make visitors' browsers post comments, and with a new `listen_throttle` middleware. It never runs `require_session` and never builds a `CurrentUser`, so no handler can reach owner state by accident.

Owner routes (`/api/v1/projects/{id}/shares[...]`, `/api/v1/projects/{id}/comments[...]`) join `protected` under the projects body limit. They use `PUT` rather than `PATCH`, because the CORS layer only allows GET/POST/PUT/DELETE and the existing API already uses `PUT` for partial-intent updates.

CORS is unchanged. The listen page is same-origin through the Next.js `/api` rewrite, so no new origin needs allowing. That rules out embedding on other sites, which is a non-goal.

*Alternative:* serve the listen API from the Next.js server only. Rejected: it would duplicate the projection and validation in TypeScript and leave the backend's quota, cascade, and log rules out of the path.

### D4. Projection on the server, as a typed transform
`share_store::project_song(song_json) -> Value` parses into `music::Song` only to validate, then removes `chat`, `lyric_chat`, and `sections[].notes` from the **JSON value**. Working on the value rather than re-serialising the struct follows the existing rule in `projects.rs`: round-tripping would drop fields this build does not know. A new song field is therefore served by default, which is a privacy risk. To counter it, a unit test enumerates the top-level `Song` fields and fails when a field is added without being classified as public or private.

Snapshots store the projected JSON, so private fields never reach the share table. Live links project on every read.

### D5. Instruments travel with the song
`/api/v1/instruments` needs a session, and making it public would widen the anonymous surface for no gain. The listen response includes `instruments`: the `InstrumentInfo` entries for the instrument ids the song's tracks use, taken from `state.instruments`. The listen page passes these to `useSongPlayback` directly, without `useInstruments`.

### D6. Comment anchoring by step, section resolved by the server
Comments store `at_step` (an absolute song step), because steps survive tempo changes and are what the ruler and playhead already use. The server finds the section containing `at_step` in the song the link serves at post time, and stores its id and name. Trusting a client-sent section would let a listener label a comment with an arbitrary name. Storing the name keeps the label meaningful after the owner renames or deletes the section. Live links also store `project_revision`, so the Studio can flag comments made against an older version.

In the Studio, a marker sits at `at_step`. If that is past the current song end, the marker is clamped to the end and flagged. The marker does not try to follow sections that moved: guessing could put feedback on the wrong bars, and the stored section name already tells the owner what the listener meant.

### D7. Abuse controls
- **`ShareThrottle`** (new, `share_throttle.rs`), built on the same sliding-window and sweep structure as `LoginThrottle`. It has three windows:
  - per address on reads: 60 per minute;
  - per address on comment posts: 5 per 10 minutes and 30 per day;
  - per share on comment posts: 200 per day.
  
  Every comment attempt counts, valid or not, before validation runs, so validation errors cannot be used as a free oracle. Limits come from `SONGBIRD_SHARE_READS_PER_MINUTE`, `SONGBIRD_COMMENTS_PER_ADDRESS_10M`, `SONGBIRD_COMMENTS_PER_ADDRESS_DAY`, and `SONGBIRD_COMMENTS_PER_SHARE_DAY`.
- **Hard cap** of 1,000 comments per share, checked in the insert transaction, so the throttle resetting on restart cannot grow storage without bound. Worst case is 1,000 × 2,000 characters × 20 links × 500 projects per user. That is large but bounded, and the owner deletes links.
- **Honeypot:** a filled `website` field returns a fake `201` and stores nothing, so naive bots do not learn to adapt.
- **Text rules:** NFC is not applied, because storing exactly what was sent keeps validation simple and auditable. Control characters and bidi overrides are refused, because they are the characters that make plain text lie about itself in the owner's UI.
- **Rendering:** React text nodes with `white-space: pre-wrap`, no `dangerouslySetInnerHTML`, no Markdown, and no auto-linking. Not linking URLs removes most of the value of spamming a link. A lint-level test greps the listen and comment components for `dangerouslySetInnerHTML`.

*Alternative:* CAPTCHA or proof-of-work. Deferred: either needs a third-party script or extra client code, and the CSP is self-only. Revisit if the throttle proves insufficient (open questions).

### D8. Logging redaction in the span, not after the fact
The `TraceLayer` span's `path` field is built by a `redacted_path` helper. It rewrites `/api/v1/listen/<anything>` to `/api/v1/listen/:token`, keeping any suffix such as `/comments` or `/midi`. Because the redaction happens in the one place paths enter logs, no listen handler can forget it. Handlers never log tokens, comment names, or bodies, and the create-share handler logs only the share id.

The frontend's `/listen/<token>` page path also reaches Next.js and reverse-proxy access logs. Next does not log paths in production by default. The proxy is owned by `add-vps-deployment` (open questions).

### D9. Listen page is a separate client shell
`app/listen/[token]/page.tsx` is a client page. `proxy.ts`'s matcher adds `listen` to its exclusion list, so it is never redirected. The page uses its own small fetch wrapper (`lib/listen/api.ts`), not `lib/api.ts`, so a `401` or `404` can never trigger sign-out or clear storage.

It builds an in-memory, read-only `SongStore` from the served song and reuses:
- `useSongPlayback`, with audio tracks muted through the playback model's existing missing-sample path, so it never touches `sampleStore`;
- the section ruler component, in read-only mode;
- the lyrics renderer, read-only;
- `renderMixdown` for WAV.

Listener conveniences (remembered name, own comments) use localStorage keys under `songbird-listen.<tokenPrefix>.`. They deliberately sit outside the `songbird.` per-user prefix: a listener is not the signed-in account, and a Studio sign-out should not wipe them.

`next.config` headers add `X-Robots-Tag: noindex, nofollow` for `/listen/:path*`. The existing CSP and `Referrer-Policy: same-origin` already keep the token out of third-party referrers.

### D10. Download toggle is advisory for WAV, enforced for MIDI
The listen API must send the song JSON for playback, so a determined listener can always render audio. `allow_downloads` is enforced on the server for MIDI (`404` when off) and only hides the WAV button. The share dialog states this plainly: "Listeners can still record what they hear." The toggle exists to express the owner's intent and to remove one-click export, not to provide DRM.

### D11. Snapshot quota
`project_store`'s stored-bytes check becomes `SUM(projects.size_bytes) + SUM(share_links.snapshot_bytes)` for the owner. Snapshot creation runs under `lock_owner` in one transaction with the quota check, matching how project creation avoids racing the count.

## Risks / Trade-offs

- [In-memory throttle resets on restart and does not span instances] → Acceptable while the single-instance deployment is the only supported one. The per-share hard cap bounds storage regardless. If the deployment ever scales out, the throttle must move to the database or a shared store (tracked with the existing login throttle).
- [Client address is the Next.js server when `trust_proxy` is off] → Then all listeners share one bucket and one spammer could block everyone. The deploy docs (`add-vps-deployment`) already require `trust_proxy` behind the proxy. The listen throttle logs a startup warning when deployment mode is production and `trust_proxy` is off.
- [Live links expose future edits the owner may not want heard] → Mode is explicit at creation, the dialog explains it, and snapshots exist for this case.
- [New `Song` fields are public by default through the projection] → A classification test fails the build until a new field is marked public or private (D4).
- [Token in the URL can leak through browser history, screenshots, or forwarding] → Inherent to capability URLs. Mitigated by expiry and revocation. The token never appears in referrers or server logs.
- [Comment spam still reaches the owner] → Owner can turn comments off per link, delete comments, or revoke the link. The volume is bounded by D7.
- [Access gate blocks listeners in production] → Documented dependency. Shares work only once the operator disables the gate.

## Migration Plan

1. Ship migration `0004_share_links` for SQLite and Postgres. It is additive, so existing data is untouched, and `cargo test -p api` checks that the two directories match.
2. Deploy the backend and frontend together. Owner routes are inert until the Studio exposes "Share".
3. Rollback: the previous build refuses to start against a database that applied `0004` (existing startup check). To roll back fully, restore the pre-deploy backup or apply a manual `DROP TABLE share_comments; DROP TABLE share_links;` and delete the `0004` row from the migrations table. This is documented in `src/db/README.md`.

## Open Questions

- **Access gate interplay:** should `add-vps-deployment`'s gate exempt `/listen/*` and `/api/v1/listen/*` instead of being turned off entirely? That decision belongs to that change. This one works either way.
- **Re-copyable URLs:** if owners find "shown once" painful, encrypt tokens with the API-key master key (D1 alternative) in a follow-up.
- **Reverse-proxy access logs:** should Caddy (or the chosen proxy) redact `/listen/<token>` paths too? Owned by `add-vps-deployment`.
- **Public comments:** should owners be able to make comments visible to all listeners on a link? It would need moderation before publication, so it is out of scope here.
- **Audio for shared songs:** a later change could let the owner upload a compressed render or the sample audio for a share. It would need size quotas, content-type checks, and served-from-API access control.
- **Stronger spam control:** proof-of-work or a self-hosted CAPTCHA, if the throttle and honeypot prove insufficient in practice.
- **Owner notifications:** an email or in-app badge outside the Studio when new comments arrive.
