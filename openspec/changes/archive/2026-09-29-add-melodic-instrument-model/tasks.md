# Tasks

## 1. Instrument model and pitch rows

- [x] 1.1 Add `InstrumentKind`, `PitchRange`, `midi_program`, and `range` to `Instrument` and `InstrumentInfo` in `backend/crates/music/src/instruments/mod.rs`, and set drums to `kind: Drums`, `midi_program: None`, `range: None`; verify the existing `info_mirrors_definition` test plus new assertions for the drum fields pass
- [x] 1.2 Add `pitch_name(midi)` and `parse_pitch(raw)` helpers (new `instruments/pitch.rs`) per design D3; verify unit tests: 60→`C4`, 61→`C#4`, 21→`A0`, and `Db4`/`db4`/`C#4`/`60` all parse to 61 or 60 as appropriate, while `H4`, `C10`, and `128` are rejected
- [x] 1.3 Add `pitch_rows(low, high)` producing high→low `RowDef`s (design D1, `LazyLock`); verify a unit test that C2–C7 yields 61 rows, first `C7`/96, last `C2`/36
- [x] 1.4 Add `instruments/piano.rs` (id `piano`, name `Piano`, channel 1, program 1, range 36–96, sustained, melodic system prompt, four example drafts per D8) and register it after drums; update `registry_lists_exactly_drums` to expect `["drums", "piano"]` and verify `cargo test -p music instruments` passes

## 2. Melodic draft resolution and variation

- [x] 2.1 Route lane resolution by instrument kind in `draft.rs::parse_section`, using `parse_pitch` and octave folding for melodic instruments (D3), with a guard for unreachable pitch classes; verify unit tests for `Bb3`→`A#3`, `60`→`C4`, `E8`→`E6`, `kick` dropped, and two lanes folding to one row keeping the louder note
- [x] 2.2 Implement the shared `melodic_phrase_end` fallback hook (D4) and set it on piano; verify `expand.rs` tests that an 8-measure repeated piano part varies measures 4 and 8, and that a 16-measure whole-note chord varies measures 4, 8, 12, and 16, with every note on a piano row
- [x] 2.3 Make `ai/prompt.rs` emit the melodic lane list and guidance through the instrument's system prompt, and add a schema snapshot `music/tests/snapshots/piano_draft_schema.json`; verify the drums schema snapshot is unchanged and the piano snapshot lists 61 lane ids

## 3. Pattern document and MIDI export

- [x] 3.1 Add `#[serde(default)] midi_program: Option<u8>` to `Pattern` in `pattern.rs`, populated by `Pattern::empty` and `expand::build_pattern`; verify tests that a drums pattern JSON without the field deserializes and a piano pattern carries program 1
- [x] 3.2 Validate `midi_program` 1–128 in `midi.rs::validate_for_export`, fall back to the instrument's program when it is absent (D5; pass the registry into the export handler in `api/src/patterns.rs`), and write the Program Change at tick 0 (D6); verify unit tests for program-change placement and wire value, no program change for drums, and chord Note Ons at tick 0 with Note Offs at 1920
- [x] 3.3 Extend the independent-parser round-trip test (the `@tonejs/midi` or midly-based test used for drums) with a piano pattern, and check that note numbers and program are recovered

## 4. API, types, and provider contract

- [x] 4.1 Add `api` integration tests: `GET /api/v1/instruments` returns ids `["drums","piano"]` with the new fields; mock `POST /api/v1/patterns/generate` with `instrument: "piano"` returns a valid 61-row pattern with `midi_program` 1; and export of that pattern returns a parseable `.mid`
- [x] 4.2 Extend the provider contract tests (the shared normalization suite run for every provider) with a melodic draft containing velocity 200, a duplicate, and an out-of-range pitch; verify identical normalized output across providers
- [x] 4.3 Add `InstrumentKind` and `PitchRange` to `music/tests/ts_bindings.rs` and run `just gen-types`; update frontend `Pattern`/`InstrumentInfo` literals (tests and fixtures) with `midi_program`/`kind`/`range`, and verify `pnpm typecheck` and `pnpm test` pass with no UI change
- [x] 4.4 Document the Piano instrument and pitch-lane format in `backend/README.md`, and verify the documented `curl` generate example for piano returns a pattern under the mock provider

## 5. Integration checks

- [x] 5.1 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`; verify both pass
- [x] 5.2 Run `just lint` and `just test`; verify both pass
- [x] 5.3 Generate a piano pattern with the Ollama provider (`just test-live-ollama` or a manual call), download its MIDI, import it into Logic Pro, and verify the pitches match the pattern; record the result in `backend/README.md`
- [x] 5.4 Run `openspec validate add-melodic-instrument-model --strict` and verify it reports the change as valid
