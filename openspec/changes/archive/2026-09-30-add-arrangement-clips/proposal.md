# Proposal

## Why

After add-multitrack-song (#4), each track is one long, undivided strip of notes. A songwriter who wants the same two-bar groove sixteen times has to draw it sixteen times. Changing the groove later means editing every copy by hand. Songs are built from repeated loops, such as a drum groove, a bassline, or a chord cycle, arranged along a timeline. The Studio needs that model before export (#5), generation (#6), and sections (#7) harden the "notes live on the track" shape into Rust types and measure-wide operations.

**Depends on:** #4 add-multitrack-song (the song document, tracks, Studio page, song store, and song library). Sequence this change **before** #5 add-song-export, so #5 mirrors the clip model in Rust instead of `Track.notes`. Archive after #4.

## What Changes

- **Loops.** Each track owns a list of **loops**, the reusable musical content. A loop has a name, a length of 1–128 measures, and notes in the track instrument's rows. Note positions are relative to the loop's start.
- **Clips.** A track's lane holds **clips**. A clip places one of that track's loops at a start measure for a length in whole measures.
  - A clip longer than its loop repeats the loop. A shorter clip plays only the start of the loop.
  - Clips on the same track do not overlap and stay within the song.
- **Linked by default.** Every clip of a loop plays that loop's current notes. Editing the loop from any clip changes every placement. **Make unique** gives a clip its own copy of the loop, so it can be edited separately.
- **Arrangement editing.** On a lane the user can:
  - create a clip with a new empty loop;
  - select, move, and resize clips (snapped to measures);
  - duplicate a clip as a linked copy, or place any existing loop of the track;
  - rename a loop, make a clip unique, and delete clips.
  - Every action has a keyboard path, and each gesture is one undo step.
- **Loop editing in the dock.** Selecting a clip opens its loop in the docked piano roll. The grid is as long as the loop, not the song. The user can change the loop's length there. The playhead shows where playback is inside the loop whenever the playhead is within the selected clip.
- **Lane overview.** Each clip is drawn as its own block, labelled with the loop name, and shows its notes in miniature, with marks where the loop repeats. Clips of the same loop are visibly linked.
- **Playback** mixes every clip of every audible track. Mute, solo, the loop range, and live edits behave as in #4.
- **BREAKING (song document):** `Track.notes` is replaced by `Track.loops` and `Track.clips`, and the song document `version` becomes `2`.
  - Songs saved under version 1 load automatically. Each track's notes become one loop that spans the song, placed once at measure 1, and nothing sounds different.
  - Tracks with no notes load with no loops and no clips.
- **Song length.** Shortening a song trims or removes clips instead of truncating notes. Loop contents are never changed by a length change.
- **Send to song.** The pattern becomes a loop of the pattern's length on a new track, placed at measure 1.
- **Non-goals:**
  - Clips shared across tracks, and song-wide scenes or patterns.
  - Sub-measure clip positions or lengths.
  - Loop start offsets inside a clip, fades, and per-clip transpose or gain.
  - Audio clips and recording.
  - Dragging clips between tracks.
  - Ghost notes from other clips in the piano roll.
  - A separate loop-browser panel.

## Capabilities

### New Capabilities
- `songs/clips`: This covers loops and clips on a track: the linked-loop model and make-unique, arrangement editing of clips, editing a loop in the dock, how clips are drawn in the lane overview, how clips resolve to played notes, migration of version 1 songs, and undo for these actions.

### Modified Capabilities
- `songs/multitrack` (added by #4, not yet archived): three requirements change.
  - "Song document": tracks hold loops and clips instead of `notes`, and `version` becomes 2.
  - "Song settings": shortening a song trims clips.
  - "Arrangement overview and track editing": lanes show clips, and the dock edits the selected clip's loop.
- `patterns/piano-roll-editor` (the "Send pattern to a song" requirement added by #4): the sent pattern becomes a loop and a clip.

## Impact

- **Frontend only. No API or backend changes.**
  - `lib/song/types.ts`: `Loop`, `Clip`, and `version: 2`.
  - `lib/song/songOps.ts` and `songStore.ts`: clip and loop operations, a selected clip, and `resolveTrackNotes`.
  - `lib/song/songLibrary.ts`: migrates version 1 songs on load.
  - `lib/audio/songPlaybackModel.ts`: plays resolved notes.
  - `components/studio/`: `TrackLane`, `NoteOverview` (redrawn per clip), and `EditorDock` (loop-local grid).
  - `SendToSongButton`.
- **Downstream planning changes need updating before they are built** (via `/opsx:update`):
  - **#5 add-song-export:** Rust `Loop`/`Clip` types, validation, and a flatten step before `note_events`.
  - **#6 add-context-aware-track-generation:** read resolved notes, and write results as a new unique loop and clip.
  - **#7 add-song-sections:** measure insert and remove shift, split, and trim clips instead of notes.
  - **#8 add-section-chord-generation:** render chords into a loop and clip.
  - #9 and #10 are unaffected.
- **Storage:** song size usually shrinks, because repeats are stored once. The IndexedDB layout is unchanged apart from the document shape.
