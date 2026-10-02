# Proposal

## Why

AI generation in the Studio is one-shot. Track generation and song chat each return a single result, which is applied straight to the arrangement. When a result is close but not right, the only options are to keep it or to regenerate and lose it, so songwriters cannot compare ideas side by side. Undo already exists, but it lives only in memory: it is capped at 100 steps and lost on reload. Once a few AI edits have been layered on top of each other, getting back to "the version from before I asked the AI for a chorus" is guesswork.

Two features fix this:
- **Variations** let the user ask for several takes of the same part, audition them in place, and keep the best one.
- **Snapshots** keep a saved version history for each project, so an AI edit can always be reversed, even days later.

**Depends on:** nothing that is unarchived. It builds on archived capabilities: `songs/track-generation`, `songs/clips`, `songs/multitrack`, `songs/project-storage`, and `platform/database`.

**Interacts with:**
- `add-streaming-chat`. The auto-snapshot hook runs when the chat's final `{reply, track}` result is applied, so it works with both the streamed and the buffered response.
- `add-section-chord-generation`. When that change lands, applying generated chords and rendering chords to a track are AI-applied changes, and they take an auto snapshot through the same hook.

## What Changes

- **Bar selection on a track lane.** The user can select a contiguous range of measures on one track. Clips and tracks also count as selections: a clip selects its measures, and a track selects the whole song. A selection offers two actions:
  - "Regenerate bars": today's track generation, limited to the selection.
  - "Takes…": the new variations flow.
- **Variations (takes).** The user asks for N takes of the selection. N is 2–6, and the default is 4.
  - Each take is an ordinary track-generation request with the full cross-track context. It also carries a new optional `take` hint so the takes differ from each other.
  - Takes arrive one at a time, and each can be auditioned in place: the arrangement and playback play that take in the selected range, with the rest of the song unchanged.
  - The user can A/B a take against the original without stopping playback.
  - The user keeps one take, which is written to the track the same way a generation result is and is one undo step. The user can also keep other takes as spare loops on the track, to place later.
  - Discarding the session leaves the song unchanged.
  - Every take counts as one AI request against the existing per-minute and per-day limits. A take that is refused or fails does not cancel the takes that succeeded.
- **Track generation `take` hint.** `POST /api/v1/songs/tracks/generate` accepts an optional `take: {index, count}`.
  - It asks the provider for a distinct alternative.
  - The mock provider gives different, deterministic output for each take index, so variations can be tested.
  - Requests without `take` behave exactly as before.
- **Project snapshots (server).** Each project can hold saved versions of its song in a new table on both SQLite and Postgres. New endpoints under `/api/v1/projects/{id}/snapshots` list, create, open, rename, and delete snapshots. They have the same owner-only, `404`-for-others rules as projects.
  - There are two kinds of snapshot. **Auto** snapshots have a reason, such as `chat`, `track_generation`, `variation`, or `restore`. **Manual** snapshots are named by the user.
  - **Retention:** a project keeps at most 50 auto snapshots, and none older than 30 days. A project can hold at most 25 manual snapshots.
  - Snapshot bytes count against the user's existing 100 MiB storage quota.
  - An auto snapshot whose song is identical to the project's newest snapshot is not stored twice.
  - Deleting a project deletes its snapshots.
- **Automatic snapshots in the Studio.** Before the Studio applies any AI-generated change to the song, it saves the song as it is at that moment as an auto snapshot. AI-generated changes are a generated track part, a chat-added track, and a kept take. The upload happens in the background: if it fails, the change is still applied and the user is told that no restore point was saved.
- **History panel.** A new History tab in the Studio's right column offers the following:
  - It lists snapshots, newest first, each with a diff against the current song that can be read at a glance: tracks added or removed, tempo, key, meter, and length.
  - The user can **preview** a snapshot. The song is shown and played read-only, and nothing is saved or recorded for undo.
  - The user can **restore** a snapshot. Restoring is one undo step and first saves a "before restore" auto snapshot.
  - The user can save a manual snapshot, rename a snapshot (which keeps it from being pruned), and delete a snapshot.
- **Undo.** Song-level undo and redo already exist (`songs/multitrack`, "Undo and redo on the Studio page"), and AI-applied changes are already one undo step each. This change makes that explicit in the spec, adds keeping a take and restoring a snapshot as undo steps, and keeps auditioning and previewing out of history. It does not make undo history persistent: snapshots are the persistent history.

Non-goals:
- Takes that span several tracks at once.
- Variations for song chat, pattern generation, or lyrics.
- Branching, merging, or a full note-level diff view.
- Sharing snapshots between users.
- Snapshots of songs that are not saved to an account.
- Persisting undo history or open variation sessions across reloads.

## Capabilities

### New Capabilities
- `songs/variations`: This covers bar selection on a track lane, "Regenerate bars", requesting N takes, how takes arrive and count against AI limits, auditioning a take in place, A/B against the original, keeping one take (and optionally spares), discarding, and what is locked while a session is open.
- `songs/project-snapshots`: This covers the snapshot endpoints and their ownership, validation, retention, quota, and de-duplication rules; automatic snapshots before AI-applied changes; manual snapshots; and the History panel with its at-a-glance diff, preview, restore, rename, and delete.

### Modified Capabilities
- `songs/track-generation`: ADDS the requirement "Alternative takes", which defines the optional `take` hint, its validation, and the mock provider's behavior for it. Existing requirements are unchanged.
- `songs/multitrack`: MODIFIES "Undo and redo on the Studio page" to list the AI-applied changes, keeping a take, and restoring a snapshot as single undo steps, and to exclude auditioning, previewing, and snapshot management from history.

## Impact

- **Backend (`music` crate)**:
  - `TrackGenerateBody` gains an optional `take` field, exported through ts-rs.
  - Validation adds the `invalid_take` error code.
  - The track-generation prompt gains a take instruction, emitted only when a take is requested.
  - The mock provider varies its output by take index.
- **Backend (`api` crate)**:
  - New `snapshots.rs` routes nested under the projects router, so they inherit the session requirement, the origin check, and the 2 MiB body limit.
  - A new `snapshot_store.rs`.
  - Migration `0004_project_snapshots.sql` for both SQLite and Postgres.
  - The quota calculation in `project_store.rs` adds snapshot bytes.
  - A per-user limit on how often snapshots can be created, which reuses `AiLimiter::with_window`.
- **Frontend**:
  - The song store gains a bar selection and a non-history "preview song" overlay, which is shared by take audition and snapshot preview.
  - A variation-session controller and a Takes panel in the editor dock.
  - A History tab in `RightColumnTabs`.
  - A snapshot API client.
  - An `autoSnapshot` hook that runs before every AI result is applied (`useTrackGeneration`, `useChat`, and keeping a take).
- **AI cost**: N provider calls per variation request, each metered as one request. At the default 10 requests per minute, 4 takes use 40% of a minute's budget. The Takes dialog shows the cost before the user submits.
- **Data**: no change to the song document or its `version`. Snapshots store the song JSON as sent, including fields this version does not recognise, as projects already do.
