# Tasks

## 1. Downstream planning alignment

- [ ] 1.1 Run `/opsx:update` on:
  - `add-song-sections`: decide how derived song length and sections interact;
  - `add-timeline-loop-region`: the region is bounded by the visible timeline;
  - `add-midi-keyboard-input`: recording past the last clip lengthens the song;
  - `add-context-aware-track-generation`: send the key as context.
  - Verify `openspec validate` passes for each updated change.

## 2. Song model: derived length, key, meter

- [ ] 2.1 Add the optional `Song.key` field with a C major default, `normalizeSong` (derived `measures`), and `timelineMeasures` (design D1 and D4). Call them from every clip op and from `migrate.ts`. Remove `setSongLength`. Verify Vitest cases for:
  - "New song defaults" and "Length follows the clips";
  - "Lengthen appends silence" and "Shorten trims clips";
  - "Old song without a key";
  - a stale stored `measures` corrected on load.
- [ ] 2.2 Switch the clip ops' bounds from `song.measures` to `timelineMeasures`, set `NEW_CLIP_MEASURES = 1`, and make `resizeClip` resize a loop only that clip uses (design D2). Verify `clipOps` tests for:
  - "New clip on an empty lane", "New clip shortened by a neighbour", and "New clip past the song's end";
  - "Resizing an unshared clip resizes its loop", "Shrinking an unshared clip drops notes", and "Lengthening a clip repeats the loop";
  - "Shorten a loop";
  - "Timeline room past the end";
  - a shrink then regrow within one gesture restoring the notes.
- [ ] 2.3 Implement `setTimeSignature`, `countTimeSignatureLosses`, and `setKey` in `songOps.ts` (design D3), and `lib/music/key.ts` (design D4). Verify tests for:
  - "4/4 to 3/4 keeps beats in their bars" and "Lengthening the measure loses nothing";
  - a lossless 3/4 ↔ 6/8 conversion;
  - "Undo a key change";
  - the scale pitch classes for C major and A minor.

## 3. Studio header, dock, and arrangement

- [ ] 3.1 Have `ui-designer` specify:
  - the time signature and key pickers in `SongHeader`;
  - the key-highlight tints and the tonic marker in light and dark themes;
  - the past-the-end timeline styling;
  - the note selection outline, the marquee, and the `NoteInspector` layout on both pages.
  - Verify the result is recorded as `openspec/changes/improve-song-and-note-editing/ui-spec.md`.
- [ ] 3.2 In `SongHeader`, remove `LengthField` and add the time signature picker (with the lossy-change confirmation through `ModalDialog`) and the key picker. In `EditorDock`, remove its `LengthField` and the `setLoopLength` action. Size `Arrangement`/`ClipLane` to `timelineMeasures`, and mark the song's end. Verify RTL tests for:
  - "Cancel a lossy change";
  - "No loop length field";
  - a clip created in the empty space past the end;
  - no Length control in the header;
  - the rewritten `StudioPage.test.tsx` length cases.
- [ ] 3.3 Pass `keyHighlight` from the Studio for melodic tracks, and tint `RowLabels` and the row backgrounds (design D4). Verify RTL tests for "C major highlight", "Change key", and no highlight on drum tracks or on `/instruments/piano`.

## 4. Piano roll: selection, moving, inspector, clipboard

- [ ] 4.1 Add the pure functions to `lib/patternOps.ts`, with Vitest cases for each spec rule:
  - `moveNotes`, with bounds and a collision `null`;
  - `setVelocities` and `setLengths`, with clamping;
  - `deleteNotes`;
  - `mergeNotes`, the shared merge rule;
  - `pasteNotes`, which drops missing rows, drops notes past the end, and trims at the end.
- [ ] 4.2 Add selection state, the marquee, click/Shift/Cmd selection, double-click delete, Delete/Backspace, Cmd/Ctrl+A, and Escape to `PianoRoll`/`NoteBar` (design D5). Change "click an empty cell" to also clear the selection. Rewrite the old click-to-remove tests. Verify RTL tests for:
  - "Clicking a note selects it", "Remove a note", and "Delete the selection";
  - "Box select" and "Extend a selection";
  - selected notes' accessible names;
  - the selection resetting when the loop changes.
- [ ] 4.3 Replace the vertical-only drag with the 2-D block move and Alt+Arrow keys (design D6). Add the `patternStore` `beginGesture`/`commitGesture` pair. Make Shift-drag apply to the selection. Verify RTL tests for:
  - "Drag a note up two semitones", "Drag a note later in time", and "Move a selection as a block";
  - "Occupied row is skipped" and "Box then drag";
  - "Shift-drag a selection";
  - one undo step per drag on both pages.
- [ ] 4.4 Build `NoteInspector` (design D8) on the pattern pages and in the Studio dock. Verify RTL tests for "Set velocity for many notes", "Mixed values", and read-only length on drums.
- [ ] 4.5 Add `lib/noteClipboard.ts` and the Cmd/Ctrl+C, X, and V handling with pointer-hover and after-block paste positions (design D7). Make sure text fields keep their native behavior. Verify RTL tests for "Copy and paste after", "Paste at the pointer", "Paste into another track" (with the discarded count announced), and "Cut is undoable".

## 5. Integration checks

- [ ] 5.1 Extend `frontend/e2e/studio.spec.ts`:
  - create a 1-bar clip past the song's end, stretch it to 4 bars, and check that the dock grid is 4 bars;
  - change 4/4 to 3/4 with confirmation;
  - set the key and check the highlighted rows;
  - box-select notes, drag them, copy and paste them, and undo.
  - Add a `drum-machine` e2e test for box select plus Delete. Verify the Playwright run passes.
- [ ] 5.2 Run `just lint` and `just test`, and verify both pass.
