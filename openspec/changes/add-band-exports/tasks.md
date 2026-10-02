# Tasks

## 1. Stem rendering core (frontend)

- [ ] 1.1 Extract `renderVoices(snapshot, voices, range, opts)` from `lib/audio/mixdown.ts` (D1). It takes a range of `{startSeconds, endSeconds, tail: "trim-to-floor" | "fixed" | "none"}`, and `renderMixdown` becomes a thin caller using `trim-to-floor`. Verify that the existing `mixdown.test.ts` and `mixdown.real.test.ts` pass unchanged.
- [ ] 1.2 Add a 24-bit PCM path to `wavEncode.ts` and the worker client, keeping 16-bit the default for the mixdown. Verify with `wavEncode.test.ts` cases for the 24-bit header fields, sample packing, clipping at ±1, and the round trip of a known sine.
- [ ] 1.3 Add `renderStems(song, options, onProgress, signal)` in `lib/audio/stems.ts`, which:
  - selects voices for "Audible tracks" or "All tracks", using a snapshot with mute and solo cleared for "All tracks";
  - applies "Unity" by overriding volume and pan on the voice copies;
  - skips tracks without clips;
  - renders each voice through `renderVoices` with a fixed or no tail;
  - reports `{index, total, trackName, fraction}`.

  Verify with Vitest using the mocked Tone harness in `mixdown.test.ts`:
  - stems have equal frame counts;
  - the loop-region start frame is right;
  - muted tracks are excluded or included by option;
  - Unity ignores volume and pan;
  - Cancel between stems throws `AbortError`.
- [ ] 1.4 Add a sum-equals-mix check to the `mixdown.real.test.ts` style real-render harness. It renders a three-track song (one with delay) as stems and as a mixdown, and asserts that the sum matches within 1 LSB per stem over the shared length (spec "Stem alignment and length"). Verify that it passes locally with `npm run test`.
- [ ] 1.5 Add `lib/audio/stemZip.ts`, which builds the ZIP with `fflate.Zip` and `ZipPassThrough` (stored), names files `NN-<slug>.wav` with the `track` fallback, and writes `stems.txt` (D2). Verify with a unit test that unzips the result with `fflate.unzipSync` and checks the names, the stored method, and the `stems.txt` contents, including skipped tracks with their reasons.
- [ ] 1.6 Add `estimateStemBytes(song, options, sampleRate)` and the 2 GB limit. Verify with unit tests for the spec's "Too large" case and a small song.

## 2. Stems UI (frontend)

- [ ] 2.1 Brief `ui-designer` on the stems dialog: the options, the size estimate, the "n of N" progress, and Cancel. Also brief it on whether `SongFileActions` should group MIDI, WAV, stems, lead sheet, and project under one "Export" menu. Verify that a design note is recorded in the PR description.
- [ ] 2.2 Implement the stems dialog and the "Download stems" action in `components/studio/`:
  - options remembered for the session;
  - "Loop region" disabled without a region;
  - the tail default follows the range;
  - stems and WAV renders are mutually exclusive;
  - a clipped-stems warning after the download.

  Verify with React Testing Library tests for each spec scenario under "Stem options" and "Stem render progress, cancel, and limits".
- [ ] 2.3 Add a Playwright e2e test that downloads stems for a fixture song with two tracks, one of them muted. It unzips the download and asserts one WAV plus `stems.txt`. Verify that it passes with `npx playwright test`.

## 3. Lead-sheet model (backend `music` crate)

- [ ] 3.1 Add `fixtures/lyric_headings.json` (at least 20 cases: whitespace, case, unlinked headings, text before the first heading, repeated sections, implicit sections). Implement `music::lyrics::split_by_headings` against it (D6), and point the frontend heading parser's tests at the same fixture. Verify with a Rust test and a Vitest test that both consume the fixture.
- [ ] 3.2 Add `music::lead_sheet` with `LeadSheetOptions`, `LeadSheet`, and the builder for:
  - the header, the sections and bars (with implicit-section labels hidden), and the lyric blocks;
  - the `invalid_melody_track` and `key_required` validation.

  Export the types with ts-rs and run `just gen-types`. Verify with unit tests for the "Lead sheet endpoint", "Sections and bars", and "Lyrics on the lead sheet" scenarios.
- [ ] 3.3 (Requires add-section-chord-generation.) Place chords in bars: chords at their start beat, the held chord shown at beat 1, and canonical symbols as display text. Verify with unit tests for the "Two chords in a bar", "Held chord", and "Song without chords" scenarios, including a song with no `chords` field.
- [ ] 3.4 (Requires add-section-chord-generation.) Implement Nashville display text (D8). Verify with table tests for every quality in `fixtures/chords.json` and the spec's major, borrowed, and minor scenarios.
- [ ] 3.5 Implement the melody:
  - reuse `song_midi`'s clip expansion;
  - reduce to a single line with the highest pitch kept;
  - split into notated durations with ties per meter (D4);
  - spell pitches with the key table (D4);
  - read syllables through the topline adapter, which returns none until add-topline-melody lands (D7).

  Verify with unit tests for the overlap, tie, and flat-key scenarios, a 6/8 tie case, and a rest-filled bar.
- [ ] 3.6 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 4. MusicXML writer and endpoints (backend)

- [ ] 4.1 Add `quick-xml` to the `music` crate. Implement `music::musicxml::write(&LeadSheet)`, which writes:
  - the header, divisions, the key and time signatures, the tempo, and "Swing";
  - the rehearsal marks, the bar lines, and the harmony with offsets;
  - the melody notes, rests, and ties with lyrics;
  - slash-notehead beats where there is no melody.

  Verify with snapshot tests for a chord-only song, a melody song, and an empty-sections song, plus a harmony round-trip test that parses the output with `quick-xml`.
- [ ] 4.2 Vendor the MusicXML 4.0 XSD under `backend/crates/music/tests/fixtures/musicxml/` and add a `just` recipe that validates every snapshot with `xmllint --schema`. The test is skipped when `xmllint` is missing. Verify that the recipe passes locally.
- [ ] 4.3 Add `POST /api/v1/songs/export/lead-sheet` and `POST /api/v1/songs/export/musicxml` to `songs::router()` (D9), reusing `ValidSong`, `song_filename`, and the error envelope. Verify with integration tests for:
  - `200` with the content type and filename;
  - `422` for `invalid_song`, `invalid_melody_track`, and `key_required`;
  - deterministic output across two identical requests;
  - no provider being called.
- [ ] 4.4 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.
- [ ] 4.5 Hand groups 3–4 to `code-reviewer`, and verify that its findings are resolved.
- [ ] 4.6 Manually open the three snapshot files in MuseScore 4. Confirm that there is no repair prompt, and that the title, tempo, rehearsal marks, chord symbols, slashes, and melody are present. Record the result in the PR description.

## 5. Lead-sheet UI and print view (frontend)

- [ ] 5.1 Add the lead-sheet API client and the "Lead sheet" dialog, with these controls:
  - the melody track picker (melodic tracks only; the default is the topline track if marked, else none);
  - the chord display, with Nashville disabled without a key;
  - the lyrics toggle;
  - the missing-input notes;
  - "Download MusicXML".

  Verify with React Testing Library tests for the "Lead sheet action in the Studio" scenarios.
- [ ] 5.2 Add the client-only print route `/songs/[id]/lead-sheet` with the "Chart" layout drawn from the `LeadSheet` JSON:
  - the header;
  - four bars per line, with each section starting a new line;
  - chords at their beat positions, raised Nashville suffixes, and `%` similes;
  - the lyric blocks and the unplaced lyrics;
  - a print stylesheet that hides the chrome and keeps sections from splitting across pages.

  Verify with component tests for the "Simile bar" and "Chart without chords or lyrics" scenarios, plus a Playwright test that emulates `print` media and screenshots the chart for a fixture song.
- [ ] 5.3 Add the `verovio` dependency, dynamically imported only by the "With melody" layout, which renders the MusicXML endpoint's output to SVG pages and appends the unaligned lyric blocks. Verify with these tests:
  - a Vitest test with a mocked loader shows the error state when loading fails, and the Chart layout still works;
  - a Playwright test shows the staff for a melody fixture;
  - `next build` output shows that Verovio is not in the Studio page's first-load chunks.
- [ ] 5.4 Add Verovio's LGPL-3.0 notice to the third-party notices (or the README licenses section, if no notices file exists), and verify that the notice is present.
- [ ] 5.5 Run `npm run lint`, `npm run test`, and `npx tsc --noEmit` in `frontend/`, and verify that all pass.

## 6. Integration

- [ ] 6.1 End-to-end Playwright check on one fixture song with sections, chords, lyrics, and a lead track. Download stems, the MusicXML, and the print preview for both layouts, and assert that each artifact is produced. Verify that it passes in `just e2e`.
- [ ] 6.2 Run `code-reviewer` over the whole branch, and verify that its findings are resolved before archiving. Archive after add-section-chord-generation.
