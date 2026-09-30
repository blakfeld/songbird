# Tasks

## 1. Song types and validation (music crate)

- [ ] 1.1 Add `backend/crates/music/src/song.rs` with `Song`/`Track` (serde, ts-rs, `JsonSchema`) per design D1 and register them in `tests/ts_bindings.rs`; verify `just gen-types` writes `frontend/src/generated/Song.ts` and `Track.ts` and the binding test passes
- [ ] 1.2 Implement `Song::validate(&InstrumentRegistry) -> ValidSong` (ranges, 1–16 tracks, known instrument → `invalid_instrument`, rows of the track's instrument, notes within song; errors name the track); verify unit tests for each rejection plus a valid two-track song
- [ ] 1.3 Add `fixtures/song_validation.json` (valid and invalid songs with expected error kinds) and a Rust test that consumes it; verify it passes

## 2. Multitrack MIDI writer and endpoint

- [ ] 2.1 Extract `note_events` from `music/src/midi.rs` per design D2 without changing `pattern_to_midi` output; verify all existing `midi.rs` tests pass unmodified
- [ ] 2.2 Implement `assign_channels`, `volume_cc`, `pan_cc`, and `song_to_midi` in `music/src/song_midi.rs`; verify unit tests for "Track layout", "Program change for melodic tracks", "Notes are absolute song time", "Region length is the song length", "Empty track still exported", "Default mixer values", "Extreme values", and "Muted track keeps its notes"
- [ ] 2.3 Add a round-trip test parsing the output with `midly`'s reader recovering channel, notes, velocities, starts, and durations per track; verify it passes
- [ ] 2.4 Add `api/src/songs.rs` with `POST /api/v1/songs/export/midi` (filename slug, `audio/midi`, `ApiError::InvalidSong` → `422 invalid_song`), merged in `routes.rs`; verify `oneshot` integration tests for the success, unknown-row, and unknown-instrument scenarios, and add a test asserting a dense 16-track × 128-measure song serializes to under 1 MiB
- [ ] 2.5 Apply the 1 MiB `DefaultBodyLimit` to the songs router (design D3, shared constant for #9's lyrics router); verify integration tests: 600 KiB song accepted, 2 MiB → `413 payload_too_large` with CORS headers, 1 MiB to `/api/v1/patterns/generate` still `413`
- [ ] 2.6 Run from `backend/`: `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`; verify both pass

## 3. Frontend: generated types, project files, Studio actions

- [ ] 3.1 Replace `frontend/src/lib/song/types.ts` imports with `@/generated/Song`/`Track`; verify `pnpm typecheck` and existing song tests pass
- [ ] 3.2 Implement `lib/song/projectFile.ts` (`serializeProject`, `parseProjectFile` per design D4, 5 MB pre-read check) and a Vitest test consuming `fixtures/song_validation.json`; verify tests for round trip, newer version, unknown instrument, invalid JSON, and "Unrecognised optional field kept"
- [ ] 3.3 Add `exportSongMidi` to `lib/api.ts` and Studio toolbar actions Download MIDI, Download project, Open project (id regeneration on collision, error display); verify RTL tests for download filename, "Duplicate id kept separately", and failed export leaving the song unchanged

## 4. Integration checks

- [ ] 4.1 Add a Playwright test: build a two-track song, download the project, open it as a new song, and download MIDI; verify the MIDI file parses with `@tonejs/midi` into 3 tracks with expected channels
- [ ] 4.2 Run `just lint` and `just test`; verify both pass
- [ ] 4.3 Manually import an exported three-track song into Logic Pro; record the result and the CC7 behavior note in `backend/README.md`
- [ ] 4.4 Run `openspec validate add-song-export --strict`; verify it passes
