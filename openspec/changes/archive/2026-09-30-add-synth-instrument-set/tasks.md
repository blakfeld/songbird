# Tasks

## 1. Backend instruments

- [x] 1.1 Add `instruments/melodic.rs` with a shared melodic constructor (D1) and refactor `piano.rs` onto it; verify the existing piano tests and snapshot are unchanged
- [x] 1.2 Add the seven instrument modules (id, name, program, range per the `instruments/melodic` catalog, role-specific prompt, four example drafts each) and register them in spec order; verify a registry test that asserts the nine ids in order, and per-instrument tests for program, range, row count (for example bass 28 rows `G3`…`E1`), and channel 1
- [x] 1.3 Add a schema snapshot per new instrument under `music/tests/snapshots/`; verify `cargo test -p music` passes and the drums and piano snapshots are unchanged

## 2. Monophonic generation

- [x] 2.1 Add `Monophony` to `Instrument` (default `None`) and apply it in `expand.rs` before `settle` (D2); verify unit tests: bass keeps `C2` over `G2` at step 0, synth-lead keeps `C5` over `E4` at step 8, bass `C2` length 8 is clipped to 4 by `F2` at step 4, clipping works across a measure boundary, and piano chords are unaffected
- [x] 2.2 Add an `api` integration test using the mock provider that generates each of the seven instruments and checks that `instrument`, `rows`, `midi_channel`, and `midi_program` match `GET /api/v1/instruments`, and that bass and synth-lead patterns have at most one note per step

## 3. Frontend voices

- [x] 3.1 Add the seven presets to `frontend/src/lib/audio/presets.ts` (D3); verify Vitest tests of the preset properties: organ sustain 1, pluck sustain 0 and decay under 1 s, synth-pad attack greater than piano attack, and every catalog id having an explicit preset (not the fallback)
- [x] 3.2 Extend the e2e suite with a parameterized test that opens `/instruments/<id>` for each new instrument, generates with the mock provider, and plays and stops without console errors; verify it passes in `just test`
- [x] 3.3 Tune the presets by ear in `just dev`, then list the instruments in the root `README.md`; verify every landing-page link opens a working editor

## 4. Integration checks

- [x] 4.1 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`; verify both pass
- [x] 4.2 Run `just gen-types` (expect no type changes), `just lint`, and `just test`; verify all pass
- [x] 4.3 Run `openspec validate add-synth-instrument-set --strict` after `add-melodic-instrument-model` and `add-melodic-piano-roll` are archived; verify it reports the change as valid with no archive warnings
