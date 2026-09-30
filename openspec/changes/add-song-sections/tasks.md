# Tasks

## 1. Section model and pure operations

- [ ] 1.1 Add `Section` and `SectionKind` to `backend/crates/music/src/song.rs` and an optional `Song.sections` (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`). Extend `Song::validate` with the section rules: 1–32 measures each, lengths summing to `Song.measures`, notes ≤ 5,000 characters, and unique ids. Register the types in `tests/ts_bindings.rs` and run `just gen-types`. Extend `lib/song/projectFile.ts` validation to match, and add valid and invalid sectioned songs to `fixtures/song_validation.json`. Verify that:
  - the Rust and Vitest fixture tests pass;
  - a song without sections serializes byte-identically to before;
  - a Vitest test loads a stored song with and without `sections`;
  - `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` pass from `backend/`.
- [ ] 1.2 Create `frontend/src/lib/songSectionOps.ts` with:
  - `sectionsOf` (the implicit section, D2)
  - `sectionStarts` (prefix sums)
  - `insertMeasures`
  - `removeMeasures` (D3)
  
  Verify with Vitest tests for:
  - an insert shifting later notes
  - a removal dropping notes that start in range, truncating notes that cross it, and shifting later notes
  - 3/4 and 6/8 step arithmetic
- [ ] 1.3 Implement these section operations in `songSectionOps.ts`:
  - add
  - insert before/after
  - rename
  - set kind
  - resize
  - duplicate (D4)
  - delete
  
  Each one materializes the implicit section first, recomputes `Song.measures`, and enforces 1–32 per section and ≤ 128 per song. Verify with one Vitest test per spec scenario in `songwriting/sections`, covering:
  - insert shifts later material
  - "Verse 2" naming
  - lengthening and shortening
  - repeating a chorus
  - deleting a bridge
  - the only section cannot be deleted
  - the cap being enforced
  - an old song being unchanged
- [ ] 1.4 Make the song-length control resize the last section when sections exist. Verify with a Vitest test that raising the length by 4 turns a 4-measure Outro into 8 measures, and that out-of-range values are rejected.

## 2. Store integration and persistence

- [ ] 2.1 Expose the section operations as song-store actions, one history entry each. Verify with Vitest tests that undoing a delete restores the section and its notes, and that redo re-applies it.
- [ ] 2.2 Add a `setSectionNotes` action that writes without a history entry (D5) and caps notes at 5,000 characters. Verify with Vitest tests that notes persist across a simulated reload of the store and that undo does not revert notes.

## 3. Section ruler, menu, and notes UI

- [ ] 3.1 Build `components/song/SectionRuler.tsx` inside the tracks' scroll container, using the grid geometry from `lib/pianoRoll.ts`. Verify with a Vitest test that each label starts at its section's first measure offset.
- [ ] 3.2 Build the add/insert/edit section dialog and the per-section menu with these actions:
  - rename
  - kind
  - length
  - duplicate
  - delete (disabled when it is the only section)
  - insert before/after
  
  It should disable sizes that would exceed 128 measures and show the reason. Verify with Vitest and React Testing Library interaction tests.
- [ ] 3.3 Add section selection (D6). Selecting a section sets the transport loop range, and clicking again or pressing Escape clears the selection. When #6's generation range control is present, pass the selection as its default. Verify with a Vitest test that selecting the chorus sets the loop to 9–16.
- [ ] 3.4 Add `components/song/SectionNotes.tsx`, a textarea for the selected section with a character count and a limit indicator. Verify with a Vitest test that Space inside it types a space and does not start playback, and that notes stay per section when the selection switches.

## 4. Compatibility with export and project files

- [ ] 4.1 Add an API integration test that `POST /api/v1/songs/export/midi` succeeds for a sectioned song and that its output matches the same song without sections. Verify that `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` pass from `backend/`.
- [ ] 4.2 Add a Vitest test that downloading and re-uploading a project file preserves sections and notes.

## 5. End-to-end and checks

- [ ] 5.1 Add a Playwright test in `frontend/e2e/song-sections.spec.ts` that uses the mock provider. It should:
  1. Create a song and add Intro, Verse, and Chorus sections.
  2. Add a note in Chorus, then duplicate Chorus and check the note appears in the copy.
  3. Delete Intro and check the shift.
  4. Type section notes, reload, and check everything persisted.
  
  Verify it passes with `pnpm test:e2e`.
- [ ] 5.2 Run `just lint`, `just test`, and `openspec validate add-song-sections --strict`, and confirm all of them pass.
