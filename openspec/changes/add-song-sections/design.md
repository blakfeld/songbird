# Design

## Context

See proposal.md for the motivation. This change builds on the song page and song store that #4 add-multitrack-song introduces.
- **Song model**: `Song { version: 1, id, name, tempo_bpm, time_signature, swing, measures: 1–128, tracks[] }`.
- **Notes**: each track's notes use the existing `Note` shape (`row_id`, `step`, `length_steps`, `velocity`). `step` is an absolute sixteenth-note index from the song start.
- **Persistence**: songs persist in the browser in IndexedDB (`songbird.songs.v1.<id>`, #4), with undo and redo in the song store. #4's loader keeps unrecognised fields.
- **Pattern editor**: the single-instrument editor keeps its stores in `frontend/src/lib/patternStore.ts` and pure operations in `frontend/src/lib/patternOps.ts`. It commits whole immutable documents to a 100-entry history (`patternStore.ts:11`). We assume the song store follows the same pattern.
- **Loop range**: this is a `LoopRange { start, end }` in measures, passed to `Transport` (`frontend/src/components/editor/Transport.tsx:16-17`). Selecting a section only has to set it.
- **Song type ownership**: since #5, `Song` and `Track` are defined in Rust (`music/src/song.rs`) and generated to `frontend/src/generated/` by ts-rs. The browser validates project files in `lib/song/projectFile.ts`, kept in step with Rust by `fixtures/song_validation.json`. #5's versioning policy applies: additive optional fields, `version` stays 1.
- **Backend**: no backend behavior depends on sections. MIDI export ignores them. They are still declared on the Rust `Song` so the generated types carry them and validation checks their ranges.

## Goals / Non-Goals

**Goals:**
- Section edits are pure functions over `Song`, so the tiling and note-shifting rules are unit-testable without a DOM.
- There is no data migration. Songs from #4 and project files from #5 keep loading.

**Non-Goals:**
- Moving or reordering sections. That needs an interaction design for dragging whole blocks and is left for a follow-up.
- Chords. #8 attaches them to sections.
- Changing tempo or meter per section.
- Section markers in MIDI export.

## Decisions

### D1. Store section lengths only, and derive start measures
`Song.sections: Section[]` stores `{ id, name, kind, measures, notes }`. Start measures are computed as prefix sums.

Storing lengths makes tiling hold by construction: gaps and overlaps cannot be represented. `Song.measures` stays in the document so that #4's code and #5's export keep working unchanged. Every section operation recomputes `Song.measures` as the sum of lengths, and a store invariant check in tests asserts they agree.

*Alternative:* store explicit `{start_measure, end_measure}` ranges. This was rejected because every edit would have to re-validate and repair the ranges.

### D2. The implicit section is a view, not data
When `sections` is absent or empty, `sectionsOf(song)` returns `[{ id: "implicit", name: "Song", kind: "other", measures: song.measures, notes: "" }]`. The first mutating section operation writes that section, with a fresh uuid, into the document and then applies the edit, all as one history entry.

This keeps untouched old songs byte-identical, and the document `version` stays 1.

*Alternative:* migrate on load. This was rejected because it would rewrite every stored song, and project files from #5 would differ from what users exported.

### D3. One measure-splice primitive
All structural edits reduce to two operations on every track:
- `insertMeasures(song, atMeasure, count, source?)`: inserts empty measures, or copies of `source`'s measures when duplicating.
- `removeMeasures(song, fromMeasure, count)`: drops notes that start in the removed range, truncates notes that cross into it, and shifts later notes earlier.

Add, insert, resize, duplicate, and delete then only differ in how they update `sections`. These live in a new `frontend/src/lib/songSectionOps.ts` next to #4's song operations. Step arithmetic uses `steps_per_measure` from the song's time signature, as `patternOps.ts` does.

**Shortening a section rule:** notes that cross the cut are truncated to end at the cut, even if they originally continued into the next section. We chose truncation over deleting the note because it keeps the part that the user can still see.

### D4. Duplicate copies notes that start inside the section
A note that starts inside the section but extends past it is copied with its length truncated at the copy's end. That way the copy never bleeds into the material that follows it. The original note is untouched.

### D5. Structural edits go through the song history; notes typing does not
Structural edits go through the song store's `commit` path and become one undo entry each.

Section notes use a plain `<textarea>`. Its edits are debounced (300 ms) into the document *without* creating history entries. The native textarea already has its own undo stack, and putting every keystroke into the song history would push note edits out of the bounded history.

`isTextEntryTarget` (`frontend/src/lib/pianoRoll.ts`) already recognizes textareas, so Space and Cmd/Ctrl+Z inside the field act on the text.

### D6. Selection is UI state, not document state
`selectedSectionId` lives in the song page's component state (and is not persisted). When the user selects a section, the page calls the existing loop-range setter with the section's measure span. When #6's generate dialog is open, it reads the selection as its default range. Deleting the selected section clears the selection.

### D7. Section ruler reuses the measure grid geometry
The ruler reuses the existing grid geometry: `MeasureRuler.tsx`, and the 28 px cell width constant in `lib/pianoRoll.ts`. It sits in the same horizontal scroll container as the tracks, so alignment needs no scroll syncing. Section actions are in a per-section menu (a button on the ruler label) and an "Add section" button at the end of the ruler. The dialog reuses `components/ui/` `Field` and `Select`.

## Risks / Trade-offs

- **[Risk]** Rust and browser validation of `sections` drift apart. **Mitigation:** both consume the new section cases in `fixtures/song_validation.json` (task 1.1). An API test checks that a sectioned song exports, and a Vitest test checks that a project file round-trips.
- **[Risk]** Structural edits on 16 tracks × 128 measures copy the whole song per history entry, so memory grows with the history. **Mitigation:** the history is already bounded (100 entries). A dense song is on the order of 100 KB, so the worst case stays around 10 MB. Revisit with structural sharing if profiling shows a problem.
- **[Trade-off]** Without reordering, rearranging a song means deleting and re-inserting. We accept that for this PR and have noted it as a follow-up.
- **[Risk]** Resizing near the 128-measure cap is confusing. **Mitigation:** the UI disables sizes that would exceed the cap and says why, as the spec requires.

## Migration Plan

No migration is needed (D2). Rollback: songs saved with `sections` by this build still load in a build without the feature, because #4's loader and #5's importer keep unrecognised fields (#5 design D1).
