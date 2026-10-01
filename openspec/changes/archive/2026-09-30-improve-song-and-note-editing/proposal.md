# Proposal

## Why

The Studio makes the songwriter manage details that should manage themselves, and it hides the musical settings that matter.
- **Lengths:** the user has to set a song's length and each loop's length by hand, even though the clips already show how long things are.
- **Meter and key:** the time signature is fixed once the song is created, and there is no key at all. A melodic part is therefore drawn without any sense of which notes fit.
- **The piano roll:** a note can only be dragged up and down, only one note can be edited at a time, and clicking a note deletes it. That makes reshaping a phrase slow and error-prone.

This change lets lengths follow the content, adds meter and key controls, and gives the piano roll the selection, move, and copy/paste tools that songwriters expect from a DAW.

## What Changes

- **No more Length fields.**
  - **BREAKING (UI):** the song header's Length field and the dock's loop Length field are removed.
  - **Song length:** the song is as long as its content. It ends at the end of its last clip, or is 1 measure when it has no clips. The timeline always shows at least 8 empty measures past the end, and at least 16 measures in total, up to 128. Clips can be created and moved into that space, which lengthens the song.
  - **Loop length:** a loop used by only one clip is as long as that clip. Resizing the clip resizes the loop: growing adds empty measures, and shrinking drops the notes past the new end. A loop shared by several linked clips keeps its length, and resizing one of its clips repeats or cuts the loop, as today.
- **New clips are 1 measure** instead of 4.
- **Time signature and key in the Studio header.**
  - **Time signature:** can be changed at any time (4/4, 3/4, 6/8). The timeline and piano roll regrid to match. Each note keeps its position within its measure. Notes that no longer fit in a shorter measure are removed, but only after the user confirms a warning that says how many. Clips keep their measures.
  - **Key:** a key picker (12 tonics × major or natural minor, default C major). It is saved with the song, and a key change is an undoable song setting.
  - **Highlighting:** in the Studio, rows of in-key pitches are highlighted on melodic piano rolls, and the tonic is marked. Drums are not highlighted.
- **Piano roll** (single-instrument pages and the Studio dock):
  - **Moving:** notes drag left, right, up, and down, snapped to steps and rows. A selection moves as a block and stops where it would collide. Alt+arrow keys move by one step or one row.
  - **Selecting:**
    - Clicking a note selects it, and Shift- or Cmd/Ctrl-click adds or removes notes from the selection.
    - Dragging on empty grid draws a selection box.
    - Cmd/Ctrl+A selects all, and Escape clears.
    - Clicking an empty cell still adds a note.
  - **BREAKING (interaction):** clicking a note no longer deletes it. Delete or Backspace removes the selection, and double-clicking a note removes that note.
  - **Note inspector:** shows velocity and length for the selection, with "Mixed" when the selected notes differ, and edits all selected notes at once. Shift-drag velocity applies to the whole selection.
  - **Copy, cut, and paste:** Cmd/Ctrl+C, X, and V. Paste goes at the step under the pointer, or right after the copied notes when the pointer is not over the grid. Pasted notes keep their rows and replace notes they overlap. Paste works across clips, tracks, and pages within the same browser tab. Every paste and cut is one undo step.
- **Non-goals:**
  - Scales other than major and natural minor, or a "no key" option.
  - Snapping notes to the key, and transposing notes when the key changes.
  - A key picker on the single-instrument pages.
  - Removing the pattern "Measures" selector on single-instrument pages.
  - Notes that start between steps.
  - Pasting through the system clipboard.
  - Selecting across clips or tracks.
  - Changing tempo or time signature partway through a song.

## Capabilities

### New Capabilities
<!-- None: all behavior extends existing capabilities. -->

### Modified Capabilities
- `patterns/piano-roll-editor`:
  - "Editing notes" changes: a click selects instead of removing, and Delete and double-click remove.
  - "Drag a note to another row" becomes "Moving notes", with horizontal moves, block moves of a selection, and keyboard moves.
  - "Shift-drag a note to change its velocity" applies to the selection.
  - Adds "Selecting notes", "Editing selected notes", "Copy, cut, and paste notes", and "Key highlighting".
- `songs/multitrack`:
  - "Song document" gains a `key`, and `measures` now follows the clips.
  - "Mixed song playback": the loop region is bounded by the visible timeline instead of the song's length.
  - "Song settings" drops Length, makes the time signature changeable with the measure-relative conversion, and adds the key.
- `songs/clips`:
  - "Creating and placing clips": clips are 1 measure by default, and are limited by the timeline instead of the song's end.
  - "Moving, resizing, and deleting clips": a clip's own loop follows the clip's length, and clips are limited by the timeline.
  - "Editing a loop in the dock": the loop Length field is removed.

## Impact

- **Frontend only. No API or backend changes.**
  - `lib/song/types.ts`: `key`, and derived `measures`.
  - `lib/song/songOps.ts`: `setTimeSignature` with its conversion, `setKey`, and `measures` recalculated after every clip change.
  - `lib/song/clipOps.ts`: `NEW_CLIP_MEASURES = 1`, the linked-aware resize, and timeline bounds.
  - `lib/patternOps.ts`: multi-note move, merge, paste, and bulk edit functions.
  - New `lib/music/key.ts`: scale membership by pitch class.
  - `lib/song/songLoop.ts`, `songStore.ts`, and `lib/audio/songPlaybackModel.ts`: the loop region is bounded by `timelineMeasures`.
  - Components: `SongHeader` (time signature and key pickers, `LengthField` removed), `EditorDock` (`LengthField` removed), `Arrangement`/`ClipLane` (the timeline's visible length), `PianoRoll`/`NoteBar` (selection, marquee, 2-D drag, inspector, clipboard), and `RowLabels` (key tint).
- **Data:** `Song.key` is optional. A song without it opens in C major, and `version` stays 2. `measures` is still stored so that downstream consumers (#5 export, generation) keep working.
- **Downstream planning changes need an update** (via `/opsx:update`):
  - **`add-song-sections`:** its song length is the sum of its sections, which conflicts with a length that follows the clips. Decide which rule wins.
  - **`add-timeline-loop-region`:** the loop region's bounds are the visible timeline, not `measures`. This change implements that rule for the Studio.
  - **`add-midi-keyboard-input`:** recording past the last clip now naturally lengthens the song, so the "growing a song while recording" non-goal changes.
  - **`add-context-aware-track-generation`:** the key becomes useful context.
