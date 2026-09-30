# Design

## Context

See proposal.md for the motivation and the specs for the behavior. The current state (paths under `frontend/src`):

**Lengths.** `SongHeader.tsx:109` and `EditorDock.tsx:214` both render `LengthField`, for the song's `measures` and for a loop's `measures`.
- `setSongLength` (`lib/song/songOps.ts`) trims clips.
- `setLoopLength` (`clipOps.ts:352`) reuses `normalizeNotes`.
- `NEW_CLIP_MEASURES = 4` (`clipOps.ts:17`).
- Clip ops clamp to `song.measures` through `freeSpanAt` and `clipEnd`.
- `totalSteps(song) = measures × steps_per_measure` (`songOps.ts:41`).

**Meter.**
- `time_signature` is chosen in `NewSongDialog` and is read-only afterward.
- `steps_per_measure` is 16 for 4/4 and 12 for 3/4 and 6/8.
- The rulers and grids read `stepsPerMeasure` and `beatSteps` from props, so a regrid follows from new props.

**Key.** There is none.

**Piano roll.**
- `PianoRoll.tsx` (387 lines) renders cells, and a click on an empty cell calls `toggleGridNote`.
- `NoteBar.tsx` handles the body drag (vertical `moveGridNote`, skipping occupied rows), the Shift-drag for velocity, and the right-edge resize.
- The `patternOps` grid functions (`toggleGridNote`, `setGridVelocity`, `resizeGridNote`, `moveGridNote`, `normalizeNotes`) take and return `NoteGrid` notes.
- Undo happens at the store level: `patternStore.edit` on pattern pages, and `songStore.editLoopNotes` plus gestures in the Studio.

## Goals / Non-Goals

**Goals:**
- Song length is a pure function of the clips, recomputed in one place.
- Every piano-roll feature lives in the shared `PianoRoll` and the `patternOps` functions, so pattern pages and the Studio dock behave the same.
- Multi-note operations are pure `(notes, selection, …) → notes` functions, tested without the DOM.

**Non-Goals:**
- Virtualizing the grid, or changing the cell-based rendering.
- A system clipboard format.

## Decisions

### D1. `measures` is derived, and `normalizeSong` enforces it
- **`normalizeSong(song)`** in `songOps.ts` sets `measures = max(1, max over clips of clip end)`. Every clip-changing `songOps`/`clipOps` result passes through it, and so does `migrate.ts` on load.
- **Why keep the stored field:** `measures` stays in the document, so #5 export, playback's `getTiming`, and the loop-region clamps keep reading one number.
- **The timeline:** `timelineMeasures(song) = min(128, max(16, measures + 8))` becomes the bound for `freeSpanAt`, `moveClip`, `resizeClip`, `placeLoop`, and `newClip`, instead of `song.measures`. `Arrangement` sizes its ruler and lanes to `timelineMeasures`. The measures past the song's end draw on a subtly different background, so the user can see where the song ends.
- **Removals:** `setSongLength`, and its `LengthField` in `SongHeader`, go away.
- **Alternative:** keep a manual length plus auto-growth. The user asked for no Length field.

### D2. A loop follows a clip that uses it alone
- **The rule:** `resizeClip` checks `useCount(loop) === 1`. In that case it also calls the existing `setLoopLength` logic, which appends empty measures or runs `normalizeNotes`, in the same `Song → Song` step. Undo therefore covers both.
- **Shared loops:** the current repeat-or-cut behavior is kept.
- **New clips:** `NEW_CLIP_MEASURES = 1`.
- **Removals:** the dock's `LengthField` and the `setLoopLength` store action are removed. The pure `setLoopLength` stays as the helper `resizeClip` uses.
- **Dragging:** the resize is `transient` during the drag, as today, so a drag that shrinks and then regrows a loop within one gesture previews from the gesture base. Notes dropped by a mid-drag shrink come back if the drag ends larger.
- **Alternative:** a loop length that is the maximum of its clips' lengths. That is harder to explain, and makes linked clips resize each other.

### D3. Time-signature conversion is measure-relative
- **`setTimeSignature(song, ts)`** rewrites each loop note as follows:
  - `m = floor(step / oldSpm)` and `o = step % oldSpm`;
  - notes with `o ≥ newSpm` are removed;
  - otherwise `step' = m·newSpm + o`, and the length is clamped to `newSpm − o`.
- **Loop lengths:** `loop.measures` is kept, so clips are unchanged.
- **Confirmation:** a companion `countTimeSignatureLosses(song, ts)` counts the removed notes, and drives the confirmation dialog (the existing `ModalDialog`).
- **3/4 ↔ 6/8:** both are 12 steps, so the conversion is lossless and only the beat grouping changes, through `beatSteps`.
- **Undo:** one `edit()` call makes it one undo step.
- **Alternative:** keep absolute step positions. The user chose measure-relative.
- **Send to song:** it already filters existing songs by matching time signature. That stays.

### D4. The key model and highlight
- **The model:** `Song.key?: { tonic: PitchClass; mode: "major" | "minor" }`. It is optional in storage. `migrate.ts` defaults it to C major, with no version bump, under the existing unknown-field pass-through.
- **Scale membership:** `lib/music/key.ts` has `scalePitchClasses(key)` (major `[0,2,4,5,7,9,11]` and natural minor `[0,2,3,5,7,8,10]` from the tonic) and `rowPitchClass(row) = row.midi_note % 12`.
- **Rendering:** `PianoRoll` gains an optional `keyHighlight` prop. It is a `Set<pitchClass>` plus the tonic. `RowLabels` and the row backgrounds apply a tint class, and the tonic rows get a stronger tint plus a small marker, so the tonic is not shown by colour alone.
- **Where it applies:** the Studio passes `keyHighlight` only for melodic instruments (`kind`), and the pattern pages don't pass it.
- **The pickers:** `SongHeader` gets a time signature `<select>` and a key control (tonic `<select>` plus a major/minor `<select>`), beside tempo and swing.

### D5. Piano-roll selection state stays inside `PianoRoll`
- **What `PianoRoll` holds:**
  - `selection: Set<noteKey>`, where `noteKey = row_id + ":" + step`;
  - the marquee;
  - `lastPasteEnd`.
- **Keeping keys in step:** operations return the updated notes plus the new selection keys, so the keys follow moved notes.
- **Resetting:** the selection resets on `resetKey`, which is the loop id or the pattern `loadId`.
- **Why not in a store:** keeping selection out of the stores means it is naturally absent from undo history and saved state.
- **The pointer model**, with a 4px threshold separating clicks from drags:
  - **Empty cell:** a click adds a note, as today, and clears the selection. A drag draws the marquee, rendered as an absolutely positioned overlay in grid coordinates. It selects notes whose `[step, step+len)` × row rectangle intersects the box. Shift adds to the selection.
  - **Note body:** a click selects, Shift or Cmd/Ctrl toggles, and a double-click deletes. A drag moves (D6), and a Shift drag changes velocity for the whole selection.
  - **Note right edge:** resizes the single note, as today.
- **Keyboard,** on the grid's existing `onKeyDown`:
  - Delete and Backspace;
  - Cmd/Ctrl+A;
  - Escape;
  - Alt+Arrow keys;
  - Cmd/Ctrl+C, X, and V.
  - These are guarded by `isTextEntryTarget` and stop propagating, so the Studio's Cmd/Ctrl+D and Space handling doesn't also fire.

### D6. Block move as a pure function with a collision stop
- **`moveNotes(notes, keys, dStep, dRow, rows, totalSteps)`** returns `null` when any moved note would leave the grid or overlap an unmoved note.
- **During a drag:** the target `(dStep, dRow)` comes from the pointer. On `null`, the last valid delta is kept. This generalizes today's "stay in the last row where it fit" rule to two dimensions.
- **Preview sound:** it plays for the dragged note only, when its row changes.
- **Replaces:** `moveGridNote`. The old single-note, vertical-only behavior is the special case of one key with `dStep = 0`.
- **Undo:**
  - On pattern pages, the drag previews through local state and commits once through `edit`. This needs a small `patternStore` gesture pair, `beginGesture`/`commitGesture`, matching the Studio store.
  - In the Studio, it uses the existing `beginGesture`/`endGesture` with a transient `editLoopNotes`.

### D7. An in-memory clipboard, with the merge rule on paste
- **Where it lives:** `lib/noteClipboard.ts` is a module-level store `{notes: Note[] (steps relative to the earliest note), span}`. It survives client-side navigation between pages in the same tab, and is lost on reload.
- **Paste position:**
  - the hovered step, when the pointer is over the grid (tracked through `pointermove`);
  - otherwise `lastPasteEnd`, which is set by copy to the copied block's end and by paste to the pasted block's end.
- **Pasting:** `pasteNotes(existing, clip, at, rows, totalSteps)` drops rows the instrument doesn't have and notes that start past the end, trims notes at the end, and merges with the rule the spec states. That is the same shape as the MIDI change's `mergeRecorded`, so the two share one `mergeNotes` function in `patternOps`, whichever change lands first. The drop count is announced through the page status region.
- **Why not the system clipboard:** `navigator.clipboard` needs permissions, and would put note JSON on the user's clipboard.

### D8. The inspector
- **Placement:** `NoteInspector` sits in the piano roll's toolbar area. On pattern pages that is the `EditorToolbar` row, and in the Studio it is the dock header.
- **Contents:** the count, a velocity number input plus slider, and a length number input. It shows "Mixed" as a placeholder.
- **Committing:** a change commits on change, or on release for the slider, through `setVelocities` and `setLengths` in `patternOps`. `setLengths` clamps each note to its next note in the row and to the end of the grid.
- **One-shot instruments:** length is read-only.

## Risks / Trade-offs

- **[Risk] Shrinking an unshared clip silently deletes loop notes** → the change is undoable, D2's in-gesture preview restores notes when the drag regrows, and the lane shows the loop's notes clipped live while dragging.
- **[Risk] Removing click-to-delete breaks muscle memory and the existing tests** → double-click and Delete are documented in the note tooltip. The existing RTL tests for "Remove a note" are rewritten.
- **[Risk] The cell grid makes marquee hit-testing and block-drag previews heavy at 128 measures** → work in step and row coordinates, not the DOM. Only the moved notes re-render during a drag.
- **[Risk] Derived `measures` conflicts with add-song-sections, where the length is the sum of the sections** → the proposal flags it, and task 1.1 updates that change before either is built.
- **[Trade-off] The key is always set.** There is no "no key", so drum-only songs carry a meaningless key. It is harmless, and useful later for AI context.

## Migration Plan

- `migrate.ts` defaults `key` and recomputes `measures` on load. There is no version bump.
- The single-instrument pages keep their `Measures` selector.
- Rollback is a frontend revert. Old code ignores `key` and tolerates recomputed `measures`.
- Update the downstream planning changes listed in proposal.md before building them.
