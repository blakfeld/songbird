# Proposal

## Why

After add-multitrack-song, a song is one undivided run of measures. Songwriters think in sections, though: intro, verse, chorus, bridge. They need to see that structure, grow or repeat a chorus without redrawing every track, and jot down what each section is for ("verse 2: the letter arrives"). Sections are also the unit that later tools key off. Chord generation (add-section-chord-generation) writes a progression per section. The lyric assistant (add-lyrics-assistant) reads section names and notes. So sections have to exist first.

**Depends on:** #4 add-multitrack-song (the Song document, tracks, song page, and song persistence), add-arrangement-clips (tracks built from loops placed as clips, and the clip operations in `lib/song/clipOps.ts`), #5 add-song-export (the Rust `Song` type that `sections` is added to, the project-file validator, and `fixtures/song_validation.json`), add-timeline-loop-region (the song's `loop_region`, the `LoopSetting` helpers in `lib/loopRegion.ts`, and the ruler's `LoopRegion`), and improve-song-and-note-editing (`normalizeSong`, which derives `measures`, the `timelineMeasures` bound for clip operations, and the removal of the song Length field). Archive after all five.

## What Changes

- **Song sections**: a song gains an ordered list of sections. Each section has a name, a kind (`intro`, `verse`, `pre-chorus`, `chorus`, `bridge`, `outro`, `other`), a length of 1–32 measures, and free-text notes.
  - Sections tile the song from measure 1 with no gaps.
  - **Sections define length.** While a song has sections, its length is the sum of its section lengths. The song cap stays at 128 measures.
  - A song without sections, including every song saved before this change, keeps the length that follows its clips (improve-song-and-note-editing) and shows as one implicit section that covers the whole song.
- **Structural editing**: the user can add or insert a section, rename it, change its kind, resize it, duplicate it, or delete it.
  - Resizing, inserting, duplicating, or deleting a section inserts, copies, or removes those measures in **every track**. Later material shifts with them, so the arrangement stays aligned.
  - These edits act on each track's **clips**, not on notes: clips move, clips crossing an edit point are split, clips inside removed measures are deleted, and duplicated measures get linked clips of the same loops. A loop's contents are never changed by a measure edit.
  - Every structural edit can be undone.
- **Section ruler**: a labelled ruler above the tracks shows the sections along the song timeline.
  - Selecting a section sets the song's loop region (add-timeline-loop-region) to that section and turns looping on.
  - The selected section also becomes the default range for per-track generation (from #6, when that change is present).
- **Section notes**: a notes field for the selected section, up to 5,000 characters, saved with the song.
- **Clips past the last section**: while a song has sections, creating, moving, or resizing a clip so that it ends after the last section lengthens the last section to cover it. Removing or shortening clips never shortens a sectioned song. There is no song Length field (improve-song-and-note-editing removed it), so a sectioned song grows only through section edits and clips placed past its end.

Non-goals:
- Reordering (moving) sections.
- Sections with different tempo or meter.
- Section markers in MIDI export.
- Server-side storage.
- Live recording.
- Rich-text notes.

## Capabilities

### New Capabilities
- `songwriting/sections`: This capability covers the song's section structure, including tiling rules, the implicit section, and structural edits and their effect on track clips. It also covers the section ruler, section selection as the loop region and generation range, section notes, persistence, and undo.

### Modified Capabilities
<!-- None. How a song's length follows its sections, instead of its clips as songs/multitrack states (improve-song-and-note-editing), is specified as an added requirement in songwriting/sections, so this change does not restate the whole Song document requirement. -->

## Impact

- **Mostly frontend.** The Rust `Song` type from #5 gets an optional `sections` field with validation. The generated TypeScript types, the browser project-file validator, and the shared validation fixture follow it. No new endpoint. The song document gets `sections`, and the song store gets section operations. `normalizeSong` (improve-song-and-note-editing) derives `measures` from the sections when a song has them, and from the clips otherwise. New components: section ruler, section editor dialog or menu, and notes panel. The song page layout changes.
- **Data**: `Song.sections` is optional. When it is absent, the song has an implicit section, so songs already saved in the browser and project files from #5 still load unchanged. The song document `version` stays 2, the version add-arrangement-clips set.
- **Backend**: types and validation only (`music/src/song.rs`). No endpoint or export behavior changes. Chords and their Rust types arrive in #8.
- **Downstream**:
  - #8 attaches chords to sections.
  - #9 reads section names and notes.
  - #6's generation range picker gains "selected section" as its default.
