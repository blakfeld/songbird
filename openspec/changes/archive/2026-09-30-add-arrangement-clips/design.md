# Design

## Context

See proposal.md for the motivation. See `specs/songs/clips/spec.md` for the required behavior. The current shape, from #4 on branch `add-multitrack-song`:

- **Types** (`lib/song/types.ts`): `Track.notes: Note[]`, with each note's `step` counted from the start of the song. `Song.version` is the literal type `1`. Fields are snake_case so that #5 can copy them into Rust unchanged.
- **Edits** (`lib/song/songOps.ts`):
  - `trackGrid(song, track, rows)` builds a `NoteGrid {notes, rows, totalSteps}` spanning the song.
  - `editTrackNotes` swaps a track's `notes` through `mapTrack`. `mapTrack` returns the same `Song` reference when nothing changes, and the store uses that to skip empty undo entries.
  - `setSongLength` runs `normalizeNotes` on every track.
- **Store** (`lib/song/songStore.ts`): undo stores whole `Song` snapshots, 100 deep. `beginGesture` and `endGesture` fold a drag into one undo step. It also holds `selectedTrackId`.
- **Dock** (`EditorDock.tsx`): passes `trackGrid(...)` to `PianoRoll`. Its edit callbacks call the `patternOps` grid functions (`toggleGridNote`, `resizeGridNote`, `moveGridNote`, `setGridVelocity`) inside `store.editTrackNotes`.
- **Playback:**
  - `songPlaybackModel.getVoices()` returns one `Voice` per track, with `notes: track.notes`.
  - For each step, `engine.ts` triggers every note in a voice where `note.step === absStep`.
  - The loop range is in song measures.
- **Library** (`songLibrary.ts`): an `idb-keyval` store, saved automatically. Loading keeps unknown fields and does not validate or migrate.
- **Overview** (`NoteOverview.tsx`): draws one region block per lane and one SVG path for all of the lane's notes.
- **Backend:** no Rust `Song` type exists yet. #5 introduces it.

## Goals / Non-Goals

**Goals:**
- Replace `Track.notes` with loops and clips. The playback engine, `PianoRoll`, and the `patternOps` grid functions stay unchanged.
- Keep a single, pure resolution function, so playback, the overview, and later export (#5) and generation context (#6) all agree on what a clip plays.
- Migrate v1 songs in one place, on load, with no audible change.

**Non-Goals:**
- Changing the engine's scheduler, apart from the cost of the voice notes it is given.
- Multi-select of clips, rubber-band selection, and snapping below a measure.
- Validating songs against the backend. That comes with #5.

## Decisions

### D1. Data shape: loops and clips both live on the track
```ts
interface Loop { id: string; name: string; measures: number; notes: Note[] } // step is relative to the loop
interface Clip { id: string; loop_id: string; start_measure: number; measures: number }
interface Track { /* mixer fields */ loops: Loop[]; clips: Clip[] }
interface Song { version: 2; /* … */ }
```
- **Why on the track:** a loop's notes are in the rows of one instrument. Storing loops per track makes a cross-instrument reference impossible to express, and it keeps deleting or duplicating a track self-contained.
- **Why whole measures:** clip positions and lengths are in whole measures, matching the loop range, the upcoming sections (#7), and the chosen non-goal of no sub-measure clips.
- **Clip order:** clips are kept sorted by `start_measure`. This makes the overlap check and "next neighbour" lookups linear and deterministic.
- **Alternatives:**
  - A song-level loop pool with an `instrument` field. Placing a loop on a track with a different instrument would then need extra rules, and the per-track scope chosen for this change doesn't need a pool.
  - Clips holding their notes inline, with a `linked_group` id. This duplicates data, and "linked" becomes a sync problem rather than a simple reference.

### D2. `resolveTrackNotes(song, track): Note[]` is the one flattening point
- **What it does:** a pure function in `lib/song/clipOps.ts`. For each clip and each repeat of its loop, it emits the loop's notes whose start falls inside the clip. Each note's step is offset by `(clip.start_measure − 1 + k·loop.measures) × steps_per_measure`. A note's `length_steps` is clamped so that it ends at the clip's end. The result has the same shape as the old `Track.notes`.
- **Consumers:**
  - `songPlaybackModel.getVoices()` sets `notes: resolveTrackNotes(...)`, so the engine is unchanged.
  - `NoteOverview` draws the resolved notes, clipped to each block.
  - #5 and #6 are told to reuse the same algorithm. #5 ports it to Rust and tests it against a shared fixture.
- **Memoization:** by `(track.loops, track.clips)` reference. Song updates are immutable, so an unrelated edit doesn't recompute other tracks. This matters because the engine calls `getVoices()` for every lookahead step.
- **Alternatives:**
  - Teach the engine about clips. This would couple the scheduler to song structure, and the single-instrument pages share the engine.
  - Precompute resolved notes and store them. This creates a second source of truth that could go stale.

### D3. The dock edits a loop-local `NoteGrid`
- **The grid:** `loopGrid(track, loop, rows, spm)` returns `{notes: loop.notes, rows, totalSteps: loop.measures × spm}`.
- **The edit path:** `store.editLoopNotes(trackId, loopId, fn)` replaces `editTrackNotes`, and the existing `patternOps` grid functions are reused as-is.
- **Loop length:** `setLoopLength` reuses `normalizeNotes`. That gives the same drop-and-truncate rule as a pattern's length.
- **Playhead:** the dock gets a derived position:
  - While the song step is inside the selected clip, the position is `(songStep − clipStartStep) mod (loop.measures × spm)`.
  - Otherwise it is `null`, and the playhead is hidden.
  - `PianoRoll` already takes a position, so only the value passed to it changes.
- **Remounting:** `resetKey` becomes the loop id, so switching between two clips of the same loop keeps scroll and zoom, while switching loops resets them.

### D4. Selection: `selectedClipId` joins `selectedTrackId` in the store
- **Consistency:** selecting a clip also sets its track. Selecting a track header picks the track's earliest clip, or `null` if it has none.
- **Undo:** selection stays out of undo history, as in #4. After an undo or redo, the existing `validSelection` step is extended to drop a `selectedClipId` whose clip no longer exists.

### D5. Clip operations are pure `Song → Song` functions with clamping inside them
- **The functions:** `lib/song/clipOps.ts` holds `newClip`, `placeLoop`, `duplicateClip`, `moveClip`, `resizeClip`, `deleteClip`, `makeUnique`, `renameLoop`, `deleteLoop`, `setLoopLength`, and `freeSpanAt(track, measure, song)`.
- **Clamping:** `moveClip` and `resizeClip` take a target and clamp it to the nearest valid position. The pointer handlers can then pass raw measure deltas, and one clamping rule covers both drags and the keyboard.
- **Returning `null`:** operations that cannot fit (duplicate with no room, a limit reached) return `null` plus a reason code. The caller shows the message through the page's existing status region.
- **Drags:** a drag uses `beginGesture`/`endGesture`, so each drag is one undo step (spec "Undo for clip and loop actions").
- **Alt/Option-drag:** it previews the original position. On drop it calls `placeLoop` with the source clip's loop and length, clamped the same way.

### D6. Version bump with an explicit load-time migration and validation
- **Why the version changes:** #4's rule was "add optional fields without bumping `version`". This change removes a field, so a v2 song read by v1 code would lose its notes. Bumping to `2` makes that incompatibility visible.
- **Migration:** `migrateSong(raw): Song` in `lib/song/migrate.ts` runs on every `load`.
  - `version: 1`: for each track with notes, it creates a loop named after the track, as long as the song, holding the same notes, placed as one clip at measure 1. A track without notes gets empty `loops` and `clips`. It then deletes `notes`.
  - `version: 2`: it runs `validateClips`, which checks that each `loop_id` resolves on the same track, that clips don't overlap and stay within the song, that loop notes fit, and that the limits hold. A failure makes the song unopenable, and the library shows "This song could not be opened". Unknown fields are still kept.
  - Migration is not saved until the next edit's autosave. Merely opening an old song therefore doesn't rewrite it.
- **Duplicate song:** it already deep-copies. Loop and clip ids only need to be unique within a song, so they are kept.

### D7. Overview rendering: one block per clip, and a colour per loop
- **Block:** each clip is an absolutely positioned `<button>`. It gets `left` and `width` from its measures, and a label with the loop name.
- **Notes:** the miniature notes are the resolved notes inside the block, drawn with the same SVG path as today.
- **Repeat marks:** faint vertical lines at each boundary where the loop repeats.
- **Linked marker:** a colour chosen by the loop's index in `track.loops`, from a small palette of about 8 accessible hues, plus the loop name. Colour is therefore never the only signal.
- **Linked label:** the accessible name adds "linked, N clips" when N > 1.
- **Double-click on empty space:** calls `newClip`. The lane's menu button offers "New clip" and "Place loop" at the measure being hovered or focused.
- **Seeking:** #4's click-to-seek moves to clicks on empty lane space. A click on a clip selects it, and does not seek.

### D8. Send to song
`addTrackFromPattern` builds one loop from the pattern, with `measures` set to the pattern's measures and the pattern's notes unchanged, because pattern steps are already relative to the pattern's start. It then adds one clip at measure 1. The existing "lengthen the song to fit" logic is unchanged.

## Risks / Trade-offs

- **Resolving 16 tracks on every lookahead tick could cost CPU** → memoize per track by reference (D2), and cover a 16-track, 128-measure song in the existing playback test that checks for drift. The engine's O(notes) scan per step is unchanged in size, because the resolved note count equals what `Track.notes` held.
- **Downstream changes (#5–#8) are written against `Track.notes`** → the proposal lists what each one needs, and task 1 runs `/opsx:update` on them before any of them is built. #5's Rust `Song` must mirror D1, and must port D2 with a shared fixture.
- **Linked edits surprise users who expect an independent copy** → the linked marker, the clip count in the dock header, and the one-click Make unique. Undo covers every edit.
- **Unplaced loops pile up in the loop menu** → they are listed with a "0 clips" count and can be deleted. There is no automatic clean-up, because a loop the user took out of the arrangement may be wanted again.
- **Opening an old song converts it to one big loop per track** → this is audibly identical, and the user can split it later by hand. There is no split tool in this change; see Open Questions.

## Migration Plan

- **Implementation order:** implement on top of #4 before #5 starts. Songs exist only in local browser storage, so there is no server migration and no rollback path beyond reverting the frontend.
- **Old code with new data:** v1 code opening a v2 song would see no `notes`. That is acceptable for a pre-release, local-only product.
- **Archive order:** archive after #4. Until #4 is archived, `openspec validate` reports that the MODIFIED deltas on `songs/multitrack` and `patterns/piano-roll-editor` ("Send pattern to a song") have no target. That is expected.

## Open Questions

- Should a "Split clip at playhead" tool follow, to break migrated whole-song loops into smaller loops? It would be additive and fits a later change without affecting this design.
