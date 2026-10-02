# Tasks

## 1. Song model: lyrics on notes and topline source

- [ ] 1.1 Add `lyric: Option<String>` to `Note` (`music/src/pattern.rs`) and `topline: Option<ToplineSource>` to `Loop` (`music/src/song.rs`), together with the `VoicePreset`, `ToplineLine`, and `ToplineSyllable` types (D1, D3). Use `#[serde(default, skip_serializing_if)]` and the ts-rs derives. Verify with Rust tests that a song without lyrics serializes byte-identically and that a song with lyrics round-trips.
- [ ] 1.2 Extend `Song::validate` and pattern validation with the lyric limits (1–16 characters, no line breaks) and the `topline` source limits. Add valid and invalid cases to `fixtures/song_validation.json`. Verify that the Rust fixture test passes and that a 17-character lyric yields `invalid_song`.
- [ ] 1.3 Run `just gen-types`, and extend `lib/song/projectFile.ts` and the frontend validation to match. Verify that the Vitest fixture test passes and that a project with a topline loop round-trips (download, then open).
- [ ] 1.4 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 2. Vocal Guide instrument (instruments/melodic)

- [ ] 2.1 Add `music/src/instruments/vocal.rs` (D10): `vocal`, "Vocal Guide", program 54, range 40–84, last in the melodic catalog, with highest-note monophonic generation. Update `fixtures/instruments.json`. Verify with these tests:
  - the existing catalog tests, plus the "Vocal Guide definition" scenario;
  - a monophonic test that `A3` and `E4` at the same step keep `E4`.
- [ ] 2.2 Add the `vocal` built-in synth voice to the frontend synth (soft attack, vowel-like tone, delayed vibrato). Verify with a Vitest test on the voice parameters (attack ≥ 40 ms, vibrato LFO present) and by listening on `/instruments/vocal`.
- [ ] 2.3 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 3. Syllabification (frontend, shared fixture)

- [ ] 3.1 Add `fixtures/syllables.json` with at least 150 cases: the spec scenarios, silent `e`, contractions, digraphs, `-tion`/`-ic` stress, prefixes, function words, numbers, non-Latin words, and punctuation. Verify that the file parses as JSON.
- [ ] 3.2 Implement `frontend/src/lib/topline/syllabify.ts` (D2): `syllabifyLine(text) -> ToplineSyllable[]`, `lyricLines(sectionBody)` (skipping blank lines), and `resplitWord(word, hyphenated)`, which refuses letter changes. Verify with a Vitest test that consumes `fixtures/syllables.json`, plus the "Correct a split" and "Split that changes letters refused" scenarios.

## 4. Topline backend

- [ ] 4.1 Add `music/src/topline.rs` with the body, the response, and `ValidToplineRequest::validate` (D3), plus the error codes `invalid_lyrics`, `lyrics_do_not_fit`, and `invalid_voice` in `api/src/error.rs`. Verify with unit tests for every validation scenario, including an empty prompt being accepted and an unknown voice giving `invalid_json`.
- [ ] 4.2 Add `ToplineProvider`, `SchemaToplineProvider`, the draft schema (`schemars` + `strictify`), and the prompt builder in `music/src/ai/topline.rs` (D4). The prompt includes `render_context`, the strong beats, the voice range, and fenced lines, section name, and prompt. Verify with a schema snapshot test, a prompt snapshot test for a song without chords, and a fence-escape test for a lyric line that holds the closing tag.
- [ ] 4.3 Implement `ToplineDraft::normalize` and the `prosody` score (D5), reusing the single-retry helper from `generate.rs`. Verify with unit tests:
  - missing syllable → invalid;
  - overlap trimmed;
  - melisma capped at 3;
  - out-of-range syllable → invalid;
  - pitch folded into the voice (C6 on Tenor becomes C4);
  - Baritone on Synth Lead clamped to C3–F4;
  - the prosody count;
  - retry-then-success, and `generation_failed` after two failures.
- [ ] 4.4 Implement `MockToplineProvider` (D6) with the `sounding_chord` helper (D7), which returns `None` until `Section.chords` exists. Verify with tests:
  - determinism;
  - "Lines on the downbeats" (8 measures, 4 lines);
  - stressed syllables on beats, with `stressed_on_beat == stressed_syllables`;
  - "Mock without chords" in D major, ending on D;
  - every pitch in the key's scale and in the voice range.
- [ ] 4.5 Add `topline` to `Providers` (`new`, `over`, `mock`) and wire `MockToplineProvider` for `mock` (D4). Add `POST /api/v1/songs/topline/generate` to `songs::ai_router`. Verify with API integration tests:
  - `200` for the "Generate a chorus topline" scenario;
  - each `422` code, with no provider call;
  - `400 invalid_json`;
  - `409 api_key_required` in per-user mode;
  - `429` when rate limited;
  - `502` using a failing double;
  - `504` using a slow double.
  
  Also verify that the existing provider and startup tests pass unchanged.
- [ ] 4.6 Add an `#[ignore]` live Ollama topline test to `just test-live-ollama` that asserts every syllable is placed and the prosody is at least 70%. Verify that it is skipped by `just test` and passes locally with Ollama running.
- [ ] 4.7 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 5. MIDI lyric events (songs/export)

- [ ] 5.1 Emit Lyric meta-events in `song_midi.rs` at each played note's Note On tick, before the Note On (D11). Verify with Rust tests for the three `songs/export` scenarios, including that a song without lyrics exports byte-identically to the current snapshot.
- [ ] 5.2 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 6. Lyrics on notes in the piano roll (patterns/piano-roll-editor)

- [ ] 6.1 Show `lyric` in `NoteBar.tsx` with ellipsis truncation, and add it to the note's accessible label. Verify with a React Testing Library test for the "Syllables shown on notes" scenario.
- [ ] 6.2 Make sure move, resize, velocity, nudge, duplicate, and copy/cut/paste (`lib/noteClipboard.ts`, `lib/patternOps.ts`) keep `lyric`, and that added notes have none. Verify with Vitest tests for each path.
- [ ] 6.3 Add the Lyric field and "Clear lyrics" to `NoteInspector.tsx`, each as one undo step, refusing more than 16 characters or line breaks. Verify with React Testing Library tests for "Edit a syllable" and "Over-long syllable refused".

## 7. Studio topline flow (songwriting/topline, songwriting/lyrics)

- [ ] 7.1 Add `generateTopline` to `frontend/src/lib/api.ts`. Verify with a Vitest test using a mocked fetch for success and for each error code.
- [ ] 7.2 Implement `lib/topline/toplineOps.ts` (D9): `reflowLyrics`, `isStale`, and `seedSyllables`. Verify with Vitest tests for "Re-flow after adding a note", "More syllables than notes", "Edited lyrics flagged", and "Corrections kept on regenerate".
- [ ] 7.3 Add `songStore.applyTopline` (D8): an optional new Vocal track, the "<section> topline" loop with its `topline` source and one clip, and linked clips on the same-named sections, all in one history entry. Refuse when the song has 16 tracks. Also add `songStore.reflowLyrics`. Verify with Vitest tests:
  - one undo removes the Vocal track and keeps the lyrics;
  - "Placed on every chorus" gives three linked clips;
  - the 16-track refusal;
  - re-flow is one undo step.
- [ ] 7.4 Build `components/topline/ToplineDialog.tsx`. It has the section header, a syllable preview with stress toggles and hyphen re-split, a fit warning, the voice selector (remembered in the browser, default Tenor), the target track list (melodic, non-sampler tracks plus "New Vocal track"), a style prompt with `TokenCounter`, the "every <name>" option, a loading state, an error state, a no-key notice, and discarding of results for a song that has since closed. Verify with React Testing Library tests for:
  - the disabled states;
  - the fit warning;
  - drums and audio tracks not being offered;
  - the error path leaving the song unchanged;
  - the prosody notice after success.
- [ ] 7.5 Add "Generate topline" to linked headings in `LyricsEditor.tsx` (keyboard reachable, no lyric undo entry) and to `SectionMenu.tsx`. In the section menu it is disabled, with a hint, when no heading is linked. Verify with React Testing Library tests for "Linked heading offers the action", "Unlinked heading has no action", and "Section without a heading".
- [ ] 7.6 Add the stale-lyrics notice with "Regenerate", and the "Re-flow lyrics" action, to the dock header (`EditorDock.tsx`) for loops with a `topline` source. Verify with React Testing Library tests for the notice appearing and disappearing, and for re-flow showing the unplaced count.

## 8. End-to-end and checks

- [ ] 8.1 Add a Playwright test, `frontend/e2e/topline.spec.ts`, using the mock provider. It should:
  1. Create Verse and Chorus sections.
  2. Add section headings and type two Chorus lines.
  3. Choose "Generate topline" on `[Chorus]` and correct one split.
  4. Generate.
  5. Check that a Vocal track has a "Chorus topline" clip over the Chorus and that its notes show the syllables.
  6. Move a note and check that its syllable stays.
  7. Edit the Chorus lyrics and check the stale notice.
  8. Undo and check that the Vocal track is gone and the lyrics are kept.
  9. Download the song MIDI and check for a Lyric event.
  
  Verify with `pnpm test:e2e`.
- [ ] 8.2 If `add-section-chord-generation` has already landed, wire `sounding_chord` to `Section.chords` and add the "Mock follows chords" and "Chords reach the provider when present" tests. Otherwise leave a note in that change's tasks to do this. Verify that the tests pass, or that the note exists.
- [ ] 8.3 Run `just lint`, `just test`, and `openspec validate add-topline-melody --strict`, and verify that all of them pass.
