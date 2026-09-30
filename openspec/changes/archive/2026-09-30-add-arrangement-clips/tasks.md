# Tasks

## 1. Downstream planning alignment

- [x] 1.1 Run `/opsx:update` on #5 `add-song-export`, #6 `add-context-aware-track-generation`, #7 `add-song-sections`, and #8 `add-section-chord-generation`. Replace their `Track.notes` assumptions with this change's model, as proposal.md Impact lists:
  - #5 gets Rust `Loop`/`Clip` types, validation, and a flatten step ported from design D2 with a shared fixture.
  - #6 and #8 read resolved notes and write their output as a new unique loop and clip.
  - #7 makes measure insert and remove shift, split, and trim clips.
  - Verify by running `openspec validate` on each changed change, and by `grep -n "Track.notes\|track's notes" openspec/changes/add-{song-export,context-aware-track-generation,song-sections,section-chord-generation}` finding no stale assumptions.

## 2. Song model, resolution, and migration

- [x] 2.1 In `frontend/src/lib/song/types.ts`, replace `Track.notes` with `loops`/`clips` per design D1:
  - `Loop`, `Clip`, and `version: 2`;
  - the limits `LOOP_MEASURE_RANGE` (1–128), `LOOP_NAME_MAX` (40), `MAX_LOOPS` (64), and `MAX_CLIPS` (256);
  - `newTrack` creates empty `loops` and `clips`.
  - Verify with an updated Vitest "New song defaults" test (tracks have no loops and no clips) and `pnpm typecheck`.
- [x] 2.2 Implement `resolveTrackNotes(song, track)` in `lib/song/clipOps.ts` per design D2, memoized by the `loops`/`clips` references. Verify with Vitest cases for these `songs/clips` "What a clip plays" scenarios:
  - "A clip repeats its loop";
  - "A short clip plays the start of its loop";
  - "A note is cut at the clip end";
  - a gap between clips is silent.
- [x] 2.3 Implement `migrateSong` and `validateClips` in `lib/song/migrate.ts` per design D6, and call them from `songLibrary.load`. Verify with Vitest and `fake-indexeddb` tests:
  - "Old song converts without audible change": a v1 song's `trackGrid` notes equal the resolved notes after migration;
  - a clip referencing another track's loop fails to open, with the "could not be opened" message;
  - opening a v1 song does not write it back until an edit;
  - an unknown extra field survives the migration.

## 3. Clip and loop operations and store

- [x] 3.1 Implement the pure operations in `lib/song/clipOps.ts` per design D5, with clamping and `null` plus a reason on failure:
  - `newClip`, `placeLoop`, `duplicateClip`, `moveClip`, `resizeClip`, `deleteClip`;
  - `makeUnique`, `renameLoop`, `deleteLoop`, `setLoopLength`;
  - `freeSpanAt`.
  - Verify with a Vitest case for every scenario under these `songs/clips` requirements: "Creating and placing clips", "Moving, resizing, and deleting clips", "Linked clips and make unique", "Managing a track's loops", and the "Clip limit" scenario.
- [x] 3.2 Rework `setSongLength` to trim and delete clips instead of calling `normalizeNotes`, and `addTrackFromPattern` to create one loop and one clip (design D8). Verify Vitest cases for:
  - `songs/multitrack` "Lengthen appends silence" and "Shorten trims clips";
  - `patterns/piano-roll-editor` "Send a drum pattern to a new song", "Song lengthened to fit", and "Short pattern into a longer song".
- [x] 3.3 In `songStore.ts`:
  - add `selectedClipId` per design D4, extending `validSelection`, with track-header selection picking the earliest clip;
  - add `editLoopNotes` to replace `editTrackNotes`, and store actions wrapping each 3.1 operation;
  - make each drag one step through `beginGesture`/`endGesture`.
  - Verify Vitest tests for "Undo a move", "Undo make unique", "Delete a placed loop" (restored by one undo), and that selecting a clip leaves `past` unchanged.

## 4. Playback

- [x] 4.1 Switch `songPlaybackModel.getVoices()` to `notes: resolveTrackNotes(...)`, with no engine changes. Verify:
  - an engine test that a 2-measure loop placed as a 6-measure clip at measure 3 triggers on the first step of measures 3, 5, and 7 only;
  - a test that editing the loop during playback is heard at the next matching step in every clip;
  - the existing multitrack playback tests pass.

## 5. Studio UI

- [x] 5.1 Have `ui-designer` extend `openspec/changes/add-multitrack-song/ui-spec.md`, or add `ui-spec.md` to this change, covering:
  - clip blocks: size, label, repeat marks, loop colour palette, and the selected state;
  - move and resize handles and cursors;
  - the lane menu (New clip, Place loop) and the clip menu (Duplicate, Make unique, Rename loop, Delete);
  - the dock header with the loop menu and length field;
  - the empty-dock state and the empty-lane hint;
  - keyboard focus order.
  - Verify the spec is recorded in this change, and that it explains where it departs from #4's "one region block per lane".
- [x] 5.2 Rebuild `TrackLane` and `NoteOverview` to draw one focusable block per clip, with the loop name, resolved miniature notes, repeat marks, and a colour per loop (design D7). Double-click on an empty measure creates a clip, and clicks on empty space still seek. Verify RTL tests for:
  - "Linked clips look linked";
  - "Accessible clip name";
  - "New clip on an empty lane";
  - "New clip shortened by a neighbour";
  - the empty-lane hint;
  - the seek-on-empty-space behavior.
- [x] 5.3 Add pointer and keyboard clip editing:
  - drag to move and right-edge resize, clamped;
  - Alt/Option-drag for a linked copy;
  - Left/Right to move, Shift+Left/Right to resize, and Delete/Backspace;
  - Cmd/Ctrl+D to duplicate;
  - the clip and lane menus;
  - failure messages through the page status region.
  - Verify RTL tests for "Move stops at a neighbour", "Lengthening a clip repeats the loop", "Duplicate after", "Duplicate with no room", "Delete keeps the loop", and the keyboard path. Verify that Cmd/Ctrl+D in a text field is not intercepted.
- [x] 5.4 Change `EditorDock` to edit the selected clip's loop through `loopGrid` and `editLoopNotes` (design D3):
  - a header showing the loop name, track, and clip count, plus the loop menu (rename, delete, clip counts) and the loop length field;
  - a loop-local playhead;
  - `resetKey` set to the loop id;
  - the empty state with New clip.
  - Verify RTL tests for "Loop-local grid", "Shorten a loop", "Dock playhead follows repeats", "Empty track", and "Edit the selected clip's loop", and that "Switching tracks keeps edits" still passes.
- [x] 5.5 Replace every remaining direct reader of `Track.notes`, such as `countNotes` in `StudioPage.tsx`, with resolved notes or loop data. Verify that `grep -rn "\.notes" frontend/src/components/studio frontend/src/lib/song` shows only loop-level uses, and that `pnpm typecheck` passes.

## 6. End-to-end and integration checks

- [x] 6.1 Extend `frontend/e2e/studio.spec.ts`:
  - create a clip, add notes, duplicate it twice, make the last copy unique and edit it, then reload;
  - after the reload, check that linked edits persisted, the unique copy differs, and playback starts with no console errors.
  - Verify that the Playwright run passes.
- [x] 6.2 Run `just lint` and `just test`, and verify both pass.
- [x] 6.3 In Chrome, manually play a 16-track, 64-measure song built from 1–2 measure loops, with about 20 clips per track. Record in design Risks any timing drift or CPU spikes compared with #4's 16-track check.
