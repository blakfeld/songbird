# Design

## Context

See proposal.md, "Why", for the motivation. The approach depends on the following parts of the current code.

**Undo already exists, and AI edits are already undoable.** The song store (`frontend/src/lib/song/songStore.ts`) works like this:
- It keeps `past` and `future` arrays of whole `Song` values, capped at `HISTORY_LIMIT = 100` (`songStore.ts:29`, `:194`).
- `undo` and `redo` are at `:665-692`.
- `applyGeneratedRange` (`:480`) and `applyChatResult` (`:120`) each push one entry. The UI already says "Undo to restore" after a generation (`useTrackGeneration.ts:49`) and after a chat-added track (`useChat.ts:66`).
- `withLiveFields` (`songLoop.ts:104-119`) makes undo and redo keep the live `chat`, `lyrics`, `lyric_chat`, and section notes, so that undoing an AI track does not erase the conversation or the words being written.
- History is in memory only, so it is lost on reload. The current `songs/multitrack` requirement says so.

This change therefore does not build undo. It specifies the AI cases and adds two new undo steps: keeping a take, and restoring a snapshot.

**Generation is pure on the client side.** `clipOps.applyGeneratedRange(song, trackId, range, notes)` (`lib/song/clipOps.ts:449`) is a pure function that returns a new `Song`. The store wraps it with the generation lock (`beginGenerating`, `endGenerating`, `generationToken`, `loadEpoch`) that already refuses section edits while a track generates.

**Server.** `POST /api/v1/songs/tracks/generate` is stateless (`api/src/songs.rs`). It is metered once per HTTP request by `ai_limits::meter`, which allows 10 requests per minute and 200 per day by default (`config.rs:89-91`). The Codex transport is serialized by a semaphore.

The mock provider (`music/src/ai/mock.rs`) chooses an example by keyword, or otherwise by an FNV `stable_hash` of the request (`:16`, `:145`). So N identical requests would return N identical takes today.

**Projects.** Projects are rows in `projects`, created by `migrations/{sqlite,postgres}/0002_accounts.sql`:
- The song is stored as `TEXT`, with an integer `revision` and millisecond timestamps.
- `project_store.rs` serializes per-owner writes with `lock_owner`, which works by updating the user row. It enforces 500 projects and 100 MiB per user with `count_and_bytes`, and a minimum of 1 s between saves.
- SQLite runs with `PRAGMA foreign_keys = ON` (`db/mod.rs:100`), so `ON DELETE CASCADE` works the same on both backends.
- The latest migration is `0003_user_api_keys.sql`.

## Goals / Non-Goals

**Goals:**
- What the user hears when auditioning a take is exactly what Keep writes.
- Every AI-applied change can be recovered after a reload, without making the AI response slower.
- Snapshots are stored with the same ownership, quota, and concurrency guarantees as projects, and behave identically on SQLite and Postgres.
- Requests without `take` are unchanged, byte for byte, so the existing prompt snapshot tests keep passing.

**Non-Goals:**
- Server-side diffing, or a note-level visual diff.
- A background job for retention. There is no scheduler in the service, so expiry happens lazily on create and list.
- Making the in-memory undo stack persistent or shared between tabs.

## Decisions

### D1. Takes are N ordinary generate requests, fanned out by the client
The Studio sends N requests with `take {index, count}` to the existing endpoint, at most two at a time.

Why:
- Metering, the daily cap, `429` with `Retry-After`, timeouts, and bring-your-own-key access all apply per take without any change to the server.
- Takes appear one at a time as they arrive, so the user can audition take 1 while take 4 is still running.
- One failed take costs only itself.

*Alternative:* a batch endpoint, `POST /songs/tracks/variations` with `count`, that makes N provider calls and returns all the takes. This was rejected for three reasons:
- It would need weighted metering, because the meter counts one request per HTTP call.
- It would hold one long request open. That is the proxy-timeout problem `add-streaming-chat` is solving for chat.
- It turns one bad take into a failed batch.

*Alternative:* one provider call that returns N drafts. Cheaper, but it multiplies output tokens and the schema size, and it gives up the per-take retry and normalization. We can revisit this if cost becomes a concern (see Open Questions).

The concurrency cap of 2 keeps a 4-take session from saturating `shed_when_busy` for other users. It also keeps the session under the default per-minute limit even when it is combined with a chat message.

### D2. The `take` hint and how the mock varies
`TrackGenerateBody` gains `take: Option<Take { index: u8, count: u8 }>`, which is validated in `ValidTrackRequest` and produces `invalid_take`. The prompt builder appends one line, and only when `take` is `Some`:

```
This is alternative take {index} of {count}; make it clearly different in rhythm or contour from other takes of the same prompt.
```

Because `None` emits nothing, the existing snapshot tests of the prompt do not change.

The mock folds `take.index` into `stable_hash`, and rotates the keyword-chosen example by `index - 1` among the instrument's examples. When the instrument has only one example, the mock additionally shifts every onset by `(index - 1)` steps, wrapping within the range, so takes still differ deterministically. A Rust test asserts that for every instrument, takes 1–4 are pairwise different.

Real providers rely on the instruction together with their normal sampling. We do not send earlier takes as "avoid this" context, because that would serialize the requests (see Open Questions).

### D3. One preview overlay, shared by take audition and snapshot preview
The song store gains state that sits outside history: `preview: { song: Song; source: "take" | "snapshot"; label: string } | null`. A selector `displaySong(s) = s.preview?.song ?? s.song` is what the arrangement, the clip lanes, and the playback scheduler read. While `preview` is set:
- every editing action becomes a no-op and returns the existing refusal path, so the message names the session;
- undo and redo do nothing;
- autosave keeps watching `song`, which does not change, so a preview can never be saved.

For a take, the preview song is `clipOps.applyGeneratedRange(song, trackId, range, take.notes)`. Keep calls the store's `applyGeneratedRange` with the same arguments. Because both go through the same pure function, the user hears exactly what Keep writes.

Switching takes and Compare (`C`) only replace `preview.song`. The scheduler already reschedules on song changes at the current position, so playback continues without a restart. The implementing agent should verify this in `lib/audio` and, if it is missing, add rescheduling at the current position as a task.

*Alternative:* write the take into the song as a transient gesture, then cancel. This was rejected because gestures are tied to a single drag, and a cancelled gesture still passes through autosave's change detection.

### D4. A variation session owns the generation lock
The session controller is `components/studio/useVariations.ts`. It holds `{trackId, range, prompt, takes: Take[], chosen, compareTarget, savedLoop}`. On start, it calls `beginGenerating(trackId)` and keeps the token until the session ends. This reuses the existing guards: sections, tempo, and meter edits are refused, and no second generation can start. Undo and redo are blocked by the preview rule in D3 for as long as a take is chosen. The controller also blocks them while "Original" is chosen, so that a later Keep can never apply to a song that undo has changed under it.

Each request has an `AbortController`. When the session ends, or when `loadEpoch` changes (the user opened another song), the controller aborts all outstanding requests and releases the lock with its token.

Keeping the chosen take and the spare loops is one new store action, `keepTake(trackId, range, notes, spares: Note[][])`. It is `applyGeneratedRange` followed by `addLoop` for each spare, done in one `edit`, so it is one undo step. It is refused as a whole, with no partial write, if `MAX_LOOPS` or `MAX_CLIPS` would be exceeded. The refusal reports how many spares would fit.

### D5. Bar selection lives in the store, outside history
`barSelection: { trackId, start, end } | null` sits beside `selectedClipId`. Shift-drag on `TrackLane` sets it, clamped to 32 measures and to measure 128 using the existing `MEASURE_RANGE`. The lane's context menu and a small floating action bar offer "Regenerate bars" and "Takes…". `useTrackGeneration` already accepts a custom range, so "Regenerate bars" opens the existing dialog with the range filled in. The last prompt for each track is kept in a session-only `Map<trackId, string>` in `useTrackGeneration`. It is not kept in the song, because the prompt is not part of the song.

### D6. The `project_snapshots` table
Migration `0004_project_snapshots.sql` is added for both backends:

```
project_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id   TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  kind TEXT NOT NULL,           -- 'auto' | 'manual'
  reason TEXT,                  -- null for manual created as manual
  label TEXT,
  song TEXT NOT NULL,
  song_hash TEXT NOT NULL,      -- sha256 hex, for de-duplication
  facts TEXT NOT NULL,          -- JSON, so listing never parses songs
  size_bytes INTEGER/BIGINT NOT NULL,
  created_at INTEGER/BIGINT NOT NULL
);
INDEX (project_id, kind, created_at);
INDEX (owner_id);
```

- `owner_id` is denormalized onto each row so that every query can filter by owner directly, matching the project_store rule "every query scoped by owner_id". `project_id` alone would need a join to enforce ownership.
- `song` is stored as the caller's JSON, not the typed struct, for the same reason that `projects.rs:51` gives for projects.
- `facts` is computed from the typed `Song` at create time.
- Ids use the same generator as projects.

*Alternative:* store deltas between snapshots instead of whole songs. This was rejected. Songs are at most 2 MiB and usually tens of KiB, whole songs make restore and preview a single read, and the quota and retention limits already bound the storage.

### D7. Concurrency, quota, and pruning in one transaction
`snapshot_store::create` does all of its work in one transaction:
1. It calls `lock_owner`, so per-user creates are serialized the same way project saves are.
2. It verifies that the project is owned by the user. If not, it returns `NotFound`.
3. It deletes this project's expired `auto` snapshots.
4. For an `auto` snapshot, it compares the hash with the newest snapshot and returns that snapshot when they match.
5. It enforces the manual cap.
6. It inserts the snapshot.
7. It prunes `auto` snapshots beyond 50, oldest first.
8. It checks the quota. When the quota is exceeded by an `auto` snapshot, it deletes this project's oldest `auto` snapshots, excluding the new one, until the user is under quota or none are left. It then commits, or rolls back with `Limit`.

`count_and_bytes` gains a second `SUM(size_bytes)` over `project_snapshots`, so project create and save count snapshot bytes as well. This means that a save can now fail with `project_limit` because of snapshots. The Studio's existing `project_limit` message stays accurate, and the History panel shows the total bytes used by snapshots, so the user can delete snapshots to free space.

Expiry also runs when snapshots are listed, so the list never shows expired snapshots. This keeps the 30-day rule true without a background job.

### D8. The client sends the song for an auto snapshot
The Studio posts the pre-change song from memory. The server does not copy `projects.song`, because autosave lags by a 300 ms debounce plus the server's 1 s minimum between saves, and the stored copy can miss the user's last edits before the AI change. Sending up to 2 MiB per AI apply is small compared with the AI call itself.

The hook is `lib/song/autoSnapshot.ts`, `snapshotThenApply(store, projectId, reason, apply)`:
1. It reads `store.getState().song` synchronously.
2. It calls `apply()` immediately, so the user never waits for the snapshot.
3. It posts the captured song in the background. On failure it shows a single, non-blocking notice.

The hook is wired into `useTrackGeneration` (`track_generation`), `useChat` (`chat`, and only when the response has a track), `keepTake` (`variation`), and, once that change lands, the chord apply and render actions (`chords`). A song that has no project yet, because its first create is still in flight, skips the snapshot and shows the same notice.

### D9. Restore keeps the conversations live
Restore does the following:
1. It posts a `restore` auto snapshot and waits for it, because a restore with no way back must be confirmed.
2. It applies `{...snapshot.song, id: current.id, chat: current.chat, lyric_chat: current.lyric_chat}` as one `edit`.

Lyrics and section notes do come from the snapshot, because "the version from last Tuesday" includes its words.

Undoing a restore goes through `withLiveFields`, which keeps the restored lyrics live. As a result, undo brings back the arrangement but not the previous lyrics, while the "Before restore" snapshot has both. See Risks.

### D10. The at-a-glance diff is computed on the client from `facts`
`lib/song/snapshotDiff.ts` compares a listed snapshot's `facts` with the current song. It reports tracks matched by id (added or removed, by name), tempo, meter, key, and length. It is a pure function with a Vitest table test, and it needs no song fetch, so the list renders from one request. The full song is fetched only for Preview and Restore.

### D11. Snapshot routes and their rate limit
`api/src/snapshots.rs` is merged into `projects::router()`, so it inherits `require_session`, `check_origin`, and the 2 MiB body limit. Snapshot creates are not AI calls, so they are not counted by the AI meter. Instead, a separate `AppState.snapshot_limiter: AiLimiter::with_window(60s)` with a limit of 30 bounds them, reusing the window implementation that `ai_limits.rs:35` already shares with the key-saving route. New error codes are `invalid_snapshot` (422) and `snapshot_limit` (409), and they are added to `error.rs` and to the frontend's error-message table.

## Risks / Trade-offs

- **[Risk]** Takes from a real provider are too similar, because parallel calls cannot see each other. **Mitigation:** the take instruction, plus a live Ollama test (`#[ignore]`) that asserts 4 takes are not all identical. A sequential "avoid these" mode is an Open Question rather than a launch requirement.
- **[Risk]** A 4–6 take session runs into the per-minute limit, especially when combined with chat. **Mitigation:** concurrency 2, `Retry-After` shown per take with Retry, and the cost shown before submit.
- **[Trade-off]** Snapshot bytes now count against the 100 MiB quota, so heavy AI use could make a project save fail with `project_limit`. Auto snapshots prune themselves first when they are created, and the History panel shows the bytes used. We accept this to keep a single quota, rather than a second hidden one.
- **[Trade-off]** Undoing a restore does not bring back the previous lyrics (D9). The "Before restore" snapshot does, and the History entry is one click away.
- **[Risk]** Previewing while a save is pending. **Mitigation:** preview never changes `song`, so the pending save writes the real song. The `song` reference is what autosave watches, and preview never touches it.
- **[Risk]** Playback glitches when switching takes mid-loop. **Mitigation:** a Playwright test switches during playback and asserts there is no stop and the playhead keeps moving. A scheduler fix is in the tasks if it is needed.

## Migration Plan

1. Deploy the backend with migration `0004` on both backends. The migration is additive, and nothing reads the table until the Studio calls it.
2. Deploy the frontend.
3. Rollback: older builds ignore `project_snapshots`. Because `ON DELETE CASCADE` is in the schema, deleting a project in an older build still deletes its snapshots. An older build's `count_and_bytes` does not count snapshot bytes, so the quota is temporarily looser after a rollback. That is acceptable. A down migration is not provided, matching `0001`–`0003`.

The song document and its `version` do not change.

## Open Questions

- Should takes from real providers be generated sequentially, with earlier takes passed as "avoid" context, if the parallel takes prove too similar? This is a provider-prompt change behind the same `take` field, and needs no spec change.
- Should the maximum take count be tied to `SONGBIRD_AI_REQUESTS_PER_MINUTE` (for example `min(6, limit / 2)`) and published through `GET /api/v1/songs/limits`? It is fixed at 6 for now.
- Should applying a lyric-assistant suggestion also take an auto snapshot? Today it is not an undo step either, and lyrics have their own undo in the editor.
- Retention numbers (50 auto, 25 manual, 30 days) are first guesses, and should be tuned once real usage data is available.
- Should spare takes be marked visually in the loop menu (for example "Bass 3 · take")? This is cosmetic and can follow later.
