# Tasks

## 1. Chord grammar (shared)

- [ ] 1.1 Add `fixtures/chords.json` with at least 40 cases. Cover every quality, sharps and flats, slash bass, each alias, and rejections (`H7`, `Cmaj13#11`, empty). Each case gives the expected canonical symbol and pitch classes, or a rejection. Verify that the file parses as JSON.
- [ ] 1.2 Implement `music/src/chords/symbol.rs`: parse, canonicalize, and `pitch_classes()`, with ts-rs and serde derives on `Chord`. Verify with a Rust test that consumes `fixtures/chords.json`.
- [ ] 1.3 Implement `frontend/src/lib/chords.ts` with the same API. Verify with a Vitest test that consumes `fixtures/chords.json`.
- [ ] 1.4 Add `key: Option<Key>` to the Rust `Song` in `music/src/song.rs`, and add `chords: Vec<Chord>` to #7's `Section`, using `#[serde(default)]` with `skip_serializing_if`. Extend `Song::validate` with the tiling rules, and export both with ts-rs. Run `just gen-types`. Extend `lib/song/projectFile.ts` validation to match, and add keyed and chorded songs, plus invalid key and invalid tiling cases, to `fixtures/song_validation.json` (#5's versioning policy: `version` stays 1). Verify that:
  - the Rust and Vitest fixture tests pass;
  - a song without key or chords serializes byte-identically;
  - an invalid key is rejected by both validators.

## 2. Chord generation backend

- [ ] 2.1 Add `ChordProvider`, `SchemaChordProvider`, and `MockChordProvider` (D2) in `music/src/ai/chords.rs`, and change `SchemaProvider` to share an `Arc` transport. Verify the following:
  - the existing provider contract tests pass unchanged;
  - a mock determinism test passes;
  - a test that the mock picks a progression by section kind passes;
  - a test that the "sad" prompt yields `A minor` passes.
- [ ] 2.2 Add the chord draft schema (via `schemars` and `strictify`, with the section-id enum) and the prompt builder (D3), including fenced section notes and context trimming. Verify with a schema snapshot test, a fence-escape test for notes, and a trimming test where TARGET sections are never dropped.
- [ ] 2.3 Implement `music/src/chords/normalize.rs` (D4). Verify with unit tests for every normalization spec scenario: gap filled, off-beat snapped, overlap trimmed, first chord pulled to 0, last chord fitted, 6/8 beat of 6 steps, and a missing section being invalid.
- [ ] 2.4 Extract a `with_one_retry` helper from `generate.rs` and use it for both patterns and chords. Verify that the existing retry tests still pass, and that new chord tests cover retry-then-success and `generation_failed` after two failures.
- [ ] 2.5 Add `api/src/chords.rs` with `POST /api/v1/songs/chords/generate` and introduce the `Providers { patterns, chords }` bundle: `build_provider` becomes `build_providers`, and `AppState.provider` becomes `AppState.providers` (D2). Verify that the existing startup and provider tests in `api/src/provider.rs` pass with `check()` running once per transport, then add integration tests for:
  - `200` for one section and for multiple sections in request order;
  - `422` for `invalid_prompt`, `prompt_too_long`, `invalid_section` (unknown or duplicate id), and `invalid_key`, each asserting that the provider was not called;
  - `502` using a failing double;
  - `504` using a slow double.
- [ ] 2.6 Add an `#[ignore]` live Ollama chord test to `just test-live-ollama`. Verify that it passes locally with Ollama running and is skipped by `just test`.
- [ ] 2.7 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 3. Chord-aware track generation (songs/track-generation)

- [ ] 3.1 Extend #6's context summarizer and system prompt with a chord line and a harmony instruction that are emitted only when chords exist (D6). Verify two things:
  - #6's existing prompt snapshot tests are unchanged for songs without chords;
  - a new snapshot test includes the chord line with absolute positions and the key.
- [ ] 3.2 Add chord budgeting to context trimming. Verify with a test that a tiny budget keeps the in-range chords and drops the far ones first.
- [ ] 3.3 Snap the melodic mock's notes to the sounding chord (D6). Verify with a Rust test that every note over an `Am`-only section has pitch class A, C, or E, and stays within the instrument's range.
- [ ] 3.4 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 4. Frontend chords, key, and lane

- [ ] 4.1 Implement `frontend/src/lib/chordOps.ts` (D8): set symbol, split, delete, move boundary, add-to-empty, and the section resize, duplicate, and delete hooks. Verify with Vitest tests for each spec scenario, plus a tiling-invariant helper asserted after every operation.
- [ ] 4.2 Call the chord hooks from #7's `songSectionOps.ts` so that section and chord edits are one history entry. Verify with Vitest tests that duplicate carries chords, lengthening extends the last chord, and undoing a section delete restores its chords.
- [ ] 4.3 Add song store actions: `setKey`, chord edits, and `applyChordGeneration` (replaces the chords of the requested sections and sets the key when it was unset, in one history entry). Verify with Vitest tests for the auto key being filled in, an explicit key being kept, and undo restoring both chords and key.
- [ ] 4.4 Add `generateChords` to `frontend/src/lib/api.ts`. Verify with a Vitest test using a mocked fetch for success and for an error-shape response.
- [ ] 4.5 Build a key selector (with Auto) in the song toolbar and a `components/song/ChordLane.tsx` beneath the section ruler, in the same scroll container. It has inline symbol editing with a validation message, split and delete actions, and boundary drag in beats. Verify with React Testing Library tests for invalid symbol rejection, splitting at beat 3, and the boundary stopping at one beat.
- [ ] 4.6 Build a "Generate chords" dialog with a prompt and token counter (reuse `TokenCounter` against `max_input_tokens` from #6's `GET /api/v1/songs/limits`, which the Studio already loads; no chord-specific limits are added there), a scope (selected section or all), and a key. It shows a loading state, and on error it shows the message and keeps the chords. Verify with React Testing Library tests for the disabled states, the error path, and the implicit section being made explicit before the request.
- [ ] 4.7 Implement `frontend/src/lib/chordVoicing.ts` (D7) and a "Render chords to track" action that lists melodic tracks only. Verify with Vitest tests: `Am` on Piano gives A3, C4, E4 for 16 steps at velocity 90; `C/E` on a bass-range instrument gives a single low E; drums tracks are not offered; the action can be undone.
- [ ] 4.8 Verify that key and chords persist across a reload and survive a project file round trip (Vitest).

## 5. End-to-end and checks

- [ ] 5.1 Add a Playwright test in `frontend/e2e/song-chords.spec.ts` using the mock provider. It should:
  1. Create Verse and Chorus sections.
  2. Generate chords for all sections and check the auto key and the lane symbols.
  3. Edit one chord.
  4. Render the Chorus to the Piano track and check the notes appear.
  5. Generate a Bass track over the Chorus and check that the notes are chord tones.
  6. Reload and check that the chords persist.
  
  Verify it with `pnpm test:e2e`.
- [ ] 5.2 Run `just lint`, `just test`, and `openspec validate add-section-chord-generation --strict`, and verify that all of them pass.
