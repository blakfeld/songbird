# Design

## Context

See proposal.md for the motivation. This change builds on the song page and song store that #4 add-multitrack-song introduces.
- **Song model**: `Song { version: 2, id, name, tempo_bpm, time_signature, swing, key, measures: 1–128, tracks[] }`.
- **Derived length** (improve-song-and-note-editing D1): `measures` is no longer set by the user. `normalizeSong(song)` in `lib/song/songOps.ts` sets it to the end of the last-ending clip (1 with no clips), and every clip operation and `migrate.ts` pass their result through it. Clip operations are bounded by `timelineMeasures(song) = min(128, max(16, measures + 8))` instead of `measures`, so a clip can be created or moved past the song's end, which lengthens the song. There is no song Length field and no `setSongLength`.
- **Tracks** (add-arrangement-clips D1): each track holds `loops` (`{id, name, measures, notes}`, with note steps relative to the loop start) and `clips` (`{id, loop_id, start_measure, measures}`, in whole measures, sorted by `start_measure`, non-overlapping). What a track plays is derived by `resolveTrackNotes` (D2). Clip operations are pure `Song → Song` functions in `lib/song/clipOps.ts` (D5). A track holds at most 64 loops and 256 clips.
- **Persistence**: songs persist in the browser in IndexedDB (`songbird.songs.v1.<id>`, #4), with undo and redo in the song store. #4's loader keeps unrecognised fields.
- **Pattern editor**: the single-instrument editor keeps its stores in `frontend/src/lib/patternStore.ts` and pure operations in `frontend/src/lib/patternOps.ts`. It commits whole immutable documents to a 100-entry history (`patternStore.ts:11`). We assume the song store follows the same pattern.
- **Loop region** (add-timeline-loop-region): playback looping is a `LoopSetting { region: { start, end } | null, enabled }` in 1-based inclusive measures, where a song starts with no region and looping off, with pure helpers (`defaultLoop`, `clampLoop`, `drawRegion`, …) in `frontend/src/lib/loopRegion.ts`. The Studio draws it on the arrangement ruler with `components/editor/LoopRegion.tsx`, and the Loop toggle beside Play switches it on or off. The song store owns it as the song's optional `loop_region { region: { start_measure, end_measure } | null, enabled }`, set through `songStore.setLoop` outside undo history. Selecting a section only has to call that setter.
- **Song type ownership**: since #5, `Song` and `Track` are defined in Rust (`music/src/song.rs`) and generated to `frontend/src/generated/` by ts-rs. The browser validates project files in `lib/song/projectFile.ts`, kept in step with Rust by `fixtures/song_validation.json`. #5's versioning policy applies: additive optional fields, `version` stays 2.
- **Backend**: no backend behavior depends on sections. MIDI export ignores them. They are still declared on the Rust `Song` so the generated types carry them and validation checks their ranges.

## Goals / Non-Goals

**Goals:**
- Section edits are pure functions over `Song`, so the tiling and clip-shifting rules are unit-testable without a DOM.
- Measure edits never change a loop's contents, so every linked clip outside the edited measures keeps playing exactly as before.
- There is no data migration. Songs from #4 and project files from #5 keep loading.

**Non-Goals:**
- Moving or reordering sections. That needs an interaction design for dragging whole blocks and is left for a follow-up.
- Chords. #8 attaches them to sections.
- Changing tempo or meter per section.
- Section markers in MIDI export.

## Decisions

### D1. Store section lengths only, and derive start measures
`Song.sections: Section[]` stores `{ id, name, kind, measures, notes }`. Start measures are computed as prefix sums.

Storing lengths makes tiling hold by construction: gaps and overlaps cannot be represented. `Song.measures` stays in the document so that #4's code and #5's export keep working unchanged. `normalizeSong` keeps it equal to the sum of lengths (D8), and a store invariant check in tests asserts they agree.

*Alternative:* store explicit `{start_measure, end_measure}` ranges. This was rejected because every edit would have to re-validate and repair the ranges.

### D2. The implicit section is a view, not data
When `sections` is absent or empty, `sectionsOf(song)` returns `[{ id: "implicit", name: "Song", kind: "other", measures: song.measures, notes: "" }]` for a song of at most 32 measures. A longer song (up to 128 measures) is shown as consecutive implicit chunks of 32 measures with the remainder last, named "Song", "Song 2", …, with ids `implicit`, `implicit-2`, …, because a single 33+ measure section would fail the 1–32 rule the moment it was materialized and the song would no longer load. Their total is therefore the clip-derived length. Once materialized, it is a real section and the song's length follows its sections from then on (D8). The first mutating section operation writes that section, with a fresh uuid, into the document and then applies the edit, all as one history entry.

This keeps untouched old songs byte-identical, and the document `version` stays 2.

*Alternative:* migrate on load. This was rejected because it would rewrite every stored song, and project files from #5 would differ from what users exported.

### D3. One measure-splice primitive, over clips
All structural edits reduce to two operations on every track's `clips`. Loops are never touched:
- `insertMeasures(song, atMeasure, count, source?)`: splits any clip that crosses `atMeasure`, then moves every clip starting at or after `atMeasure` later by `count`. With `source` (duplicating), it also copies each clip inside the source span into the inserted span, shifted by the span's offset. Copies keep their `loop_id`, so they are linked to the originals.
- `removeMeasures(song, fromMeasure, count)`: splits clips crossing `fromMeasure` and `fromMeasure + count`, deletes the clips inside the removed span, and moves later clips earlier by `count`.

Both primitives build on two helpers in `lib/song/clipOps.ts`. #6 (add-context-aware-track-generation) needs the same two for writing a generated range, so whichever of #6 and #7 is built first adds them and the other reuses them:
- `splitClip(song, trackId, clipId, atMeasure)`: the head keeps the clip's loop and ends before `atMeasure`. The tail starts at `atMeasure` and keeps the same loop when `(atMeasure − clip.start_measure)` is a multiple of `loop.measures`, because it then starts on a repeat. Otherwise the tail gets a new loop, named "<loop name> (cont.)" (truncated to 40 characters), holding exactly the notes the tail played (`resolveTrackNotes` output re-based to the tail start), with the tail's length.
- `clearMeasureRange(song, trackId, start, end)`: splits at `start` and `end + 1`, then deletes the clips inside.

Add, insert, resize, duplicate, and delete then only differ in how they update `sections`. These live in a new `frontend/src/lib/songSectionOps.ts` next to #4's song operations. Clip arithmetic is in whole measures, so the time signature only matters inside `resolveTrackNotes` when a misaligned tail is baked.

**Cutting notes:** a note that sounds across a split point is cut there, because a clip cuts its notes at its end (add-arrangement-clips, "What a clip plays"). For shortening and deleting this matches the earlier rule of truncating notes at the cut. For inserting, a note that crosses the insertion point is also cut there rather than sustaining into the new empty measures, because clips have no way to let a note ring past their end.

**Why bake a misaligned tail instead of rotating the loop:** a rotated copy would keep the loop short, but notes that wrap past its end would have to be cut, so the tail would sound different. Baking is exact. The cost is that the tail no longer repeats a short loop.

**Audio clips:** audio tracks (add-audio-tracks) hold `audio_clips` positioned in ticks with sample offsets, not measure clips of loops, so the two primitives also splice them: an audio clip at or after the edit point moves by `count` measures of ticks, one inside a removed span is deleted, and one crossing a split point is cut into a head and a tail. The tail's `offset_samples` advances by the head's length so it plays the same audio; a looping clip is split only on a boundary between repeats of its loop, where the tail keeps the same `offset_samples` and slice. A cut mid-loop is refused, because `offset_samples` is both where a looping clip starts and where it wraps to, so no single clip can start mid-loop and still wrap to the loop start, and a lead-in clip would need a start between ticks. Refusing keeps every applied edit sample-exact; the user can turn Loop off or trim the clip and retry. The cut itself falls on an integer barline tick; when that lies between two samples the head's length is rounded down so it never overlaps the tail. The head keeps the fade-in and the tail keeps the fade-out, each clamped to its piece, because adding a fade at the cut would change what is heard. A fade that crosses the cut cannot be continued exactly (a clip's fade always starts at its edge), so it is shortened instead; this is an accepted exception, since fades rarely span a section boundary and refusing would block otherwise exact edits. Duplicating copies the audio clips inside the source span the same way it copies clips. Without this, a section edit would leave recorded audio where it was while the MIDI around it moved.

**Limits:** splits can add clips and loops. An edit that would take any track past 64 loops, 256 clips, or 256 audio clips is refused as a whole, and the user is told which track is full.

*Alternative:* shift the notes inside each loop. That would change every other clip linked to the loop, which is exactly what the loop model exists to prevent.

### D4. Duplicate places linked clips
Duplicating first splits clips at the section's edges, so every clip in the source span lies inside it. Each is then copied as a clip of the **same loop**. The copy is linked, as in add-arrangement-clips' Duplicate, so a later edit to the chorus loop changes both choruses. The user can use Make unique to vary one.

A note that starts inside the section but sustains past it is cut at the copy's end, because the copied clip ends there. That way the copy never bleeds into the material that follows it.

### D5. Structural edits go through the song history; notes typing does not
Structural edits go through the song store's `commit` path and become one undo entry each.

Section notes use a plain `<textarea>`. Its edits are debounced (300 ms) into the document *without* creating history entries. The native textarea already has its own undo stack, and putting every keystroke into the song history would push note edits out of the bounded history.

`isTextEntryTarget` (`frontend/src/lib/pianoRoll.ts`) already recognizes textareas, so Space and Cmd/Ctrl+Z inside the field act on the text.

### D6. Selection is UI state, not document state
`selectedSectionId` lives in the song page's component state (and is not persisted). When #6's generate dialog is open, it reads the selection as its default range. Deleting the selected section clears the selection.

- **Selecting sets the loop region and turns looping on.** The page calls `songStore.setLoop({ region: { start, end }, enabled: true })` with the section's measure span, whether or not a region existed before. Selecting a section is a request to hear it, so leaving looping off would make the click appear to do nothing while playback runs on to the end of the song.
- **The region is not an undo step**, as add-timeline-loop-region requires, so selecting a section adds no history entry.
- **Clearing the selection leaves the region alone.** The region is the user's playback setting and is saved with the song. Clearing a UI highlight should not silently change what plays; the user can redraw the region or toggle looping instead.
- **Region edits do not change the selection.** Drawing, moving, or resizing the region on the ruler, or toggling Loop, leaves `selectedSectionId` as it is, because the selection also drives the notes panel and #6's default range.
- **Structural edits keep the region valid.** An edit that changes the song's length passes the song through `clampLoop`, so a drawn region stays inside the new visible timeline (`timelineMeasures`, add-timeline-loop-region) and no region stays none. The edit does not otherwise move the region to follow shifted sections; the user reselects the section to loop it again.

*Alternative:* select without touching `enabled`. That would keep the Loop toggle fully manual, but selecting a section while looping is off would then have no audible effect.

### D7. Section ruler reuses the measure grid geometry
The ruler reuses the arrangement's fit-to-width grid geometry: blocks are positioned with the same `--cell-w` (`100cqw / steps`) calculation that `ClipLane` uses, so a measure can be only a few pixels wide on long songs and the ruler must stay usable at that width. It sits in the same horizontal scroll container as the tracks, so alignment needs no scroll syncing. Section actions are in a per-section menu (a button on the ruler label) and an "Add section" button at the end of the ruler. The dialog reuses `components/ui/` `Field` and `Select`. The section ruler is its own row, separate from the measure ruler that hosts `LoopRegion`, because a click on the loop region already toggles looping and a click on a section must select it; sharing one strip would give one click two meanings.

### D8. Sections define length, and `normalizeSong` enforces it
While a song has sections, its length is the sum of its section lengths, not the end of its last clip. `normalizeSong` (improve-song-and-note-editing D1) gains a sectioned branch, so length is still recomputed in one place:
- **Without sections:** unchanged. `measures` is the end of the last-ending clip, or 1.
- **With sections:** when the last-ending clip ends after the last section, the last section is lengthened to end with it. `measures` is then the sum of section lengths.

Every clip operation already passes its result through `normalizeSong`, so creating, placing, duplicating, moving, or resizing a clip past the last section lengthens that section in the same `Song → Song` step and the same undo entry. Removing, moving, or shortening clips never shrinks a section, so a sectioned song never shortens because of clip edits. Section operations also pass their result through `normalizeSong`, which then only recomputes the sum.

**Bounding clip operations:** a section holds at most 32 measures, so `normalizeSong` must never have to grow the last section past that. With sections, the clip operations' bound is `min(timelineMeasures(song), lastSectionStart + 31)` instead of `timelineMeasures(song)` alone. Moves and resizes stop there, like any other end of the timeline. New clip, Place loop, and Duplicate past it are refused, and the user is told to add a section. `Arrangement` still draws `timelineMeasures` measures.

*Alternative:* let clips keep defining the length and have the last section absorb the difference in both directions. This was rejected because deleting a clip would then shrink or remove an empty outro the user made on purpose. Sections are explicit structure, and clip edits should only ever add to them.

*Alternative:* add a new "other" section to cover a clip past the end. This was rejected because every clip dragged a measure too far would leave a stray section to clean up.

## Risks / Trade-offs

- **[Risk]** Rust and browser validation of `sections` drift apart. **Mitigation:** both consume the new section cases in `fixtures/song_validation.json` (task 1.1). An API test checks that a sectioned song exports, and a Vitest test checks that a project file round-trips.
- **[Trade-off]** Splitting a long migrated clip (one whole-song loop per track) off a loop-repeat boundary bakes its tail into a new loop. Such songs gain "(cont.)" loops after section edits. They play correctly, and the user can delete unplaced ones from the loop menu.
- **[Risk]** Structural edits on 16 tracks × 128 measures copy the whole song per history entry, so memory grows with the history. **Mitigation:** the history is already bounded (100 entries). A dense song is on the order of 100 KB, so the worst case stays around 10 MB. Revisit with structural sharing if profiling shows a problem.
- **[Trade-off]** Without reordering, rearranging a song means deleting and re-inserting. We accept that for this PR and have noted it as a follow-up.
- **[Trade-off]** A clip dragged past the end silently lengthens the last section, for example an Outro. **Mitigation:** it is the same undo step as the clip edit, and the section ruler shows the new length at once.
- **[Risk]** Resizing near the 128-measure cap is confusing. **Mitigation:** the UI disables sizes that would exceed the cap and says why, as the spec requires.

## Migration Plan

No migration is needed (D2). `migrate.ts` already passes every loaded song through `normalizeSong`, so a sectioned song whose stored `measures` or last section no longer covers its clips is corrected on load (D8). Rollback: songs saved with `sections` by this build still load in a build without the feature, because #4's loader and #5's importer keep unrecognised fields (#5 design D1).
