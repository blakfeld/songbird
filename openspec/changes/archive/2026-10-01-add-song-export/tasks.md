# Tasks

## 1. Song types and validation (music crate)

- [x] 1.1 Add `backend/crates/music/src/song.rs` with `Song`/`Track`/`Loop`/`Clip` (serde, ts-rs, `JsonSchema`) mirroring add-arrangement-clips D1 per design D1 and register them in `tests/ts_bindings.rs`; verify `just gen-types` writes `frontend/src/generated/Song.ts`, `Track.ts`, `Loop.ts`, and `Clip.ts` and the binding test passes
- [x] 1.2 Implement `Song::validate(&InstrumentRegistry) -> ValidSong` (ranges, `version` 2, 1–16 tracks, known instrument → `invalid_instrument`, and the clip rules of design D1: unique ids, `loop_id` on the same track, clips within the song and not overlapping, loop notes on the instrument's rows and within the loop, ≤ 64 loops and ≤ 256 clips per track; errors name the track); verify unit tests for each rejection plus a valid two-track song
- [x] 1.3 Add `fixtures/song_validation.json` (valid and invalid songs with expected error kinds, including a cross-track `loop_id`, overlapping clips, a clip past the song end, a loop note past the loop end, and 65 loops) and a Rust test that consumes it; verify it passes
- [x] 1.4 Implement `resolve_track_notes` per design D5, store its result per track on `ValidSong`, and add `fixtures/clip_resolution.json` with the cases listed in D5 and a Rust test that consumes it; verify it passes

## 2. Multitrack MIDI writer and endpoint

- [x] 2.1 Extract `note_events` from `music/src/midi.rs` per design D2 without changing `pattern_to_midi` output; verify all existing `midi.rs` tests pass unmodified
- [x] 2.2 Implement `assign_channels`, `volume_cc`, `pan_cc`, and `song_to_midi` in `music/src/song_midi.rs`, feeding each track's resolved notes to `note_events`; verify unit tests for "Track layout", "Program change for melodic tracks", "Notes are absolute song time", "Clips are expanded", "Note cut at the clip end", "Region length is the song length", "Empty track still exported", "Default mixer values", "Extreme values", and "Muted track keeps its notes"
- [x] 2.3 Add a round-trip test parsing the output with `midly`'s reader recovering channel, notes, velocities, starts, and durations per track and comparing them with `resolve_track_notes`; verify it passes
- [x] 2.4 Add `api/src/songs.rs` with `POST /api/v1/songs/export/midi` (filename slug, `audio/midi`, `ApiError::InvalidSong` → `422 invalid_song`), merged in `routes.rs`; verify `oneshot` integration tests for the success, unknown-row, unknown-instrument, and clip-validation scenarios, and add a test asserting a dense 16-track × 128-measure song (one 128-measure loop per track) (a note on every step) serializes to under the song body limit; measured: about 1.9 MiB (1,965,630 bytes)
- [x] 2.5 Apply the 2 MiB `DefaultBodyLimit` to the songs router (design D3, shared constant for #9's lyrics router); verify integration tests: the densest 16×128 song (about 1.9 MiB) accepted, 3 MiB → `413 payload_too_large` with CORS headers, 1 MiB to `/api/v1/patterns/generate` still `413`
- [x] 2.6 Run from `backend/`: `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`; verify both pass

## 3. Frontend: generated types, project files, Studio actions

- [x] 3.1 Replace `frontend/src/lib/song/types.ts` imports with `@/generated/Song`/`Track`/`Loop`/`Clip`; verify `pnpm typecheck` and existing song and clip tests pass
- [x] 3.2 Implement `lib/song/projectFile.ts` (`serializeProject`, `parseProjectFile` per design D4 using `migrateSong` and `validateClips`, 5 MB pre-read check) and a Vitest test consuming `fixtures/song_validation.json`; point the existing `resolveTrackNotes` Vitest at `fixtures/clip_resolution.json` too; verify tests for round trip, newer version, unknown instrument, invalid JSON, invalid clips, "Unrecognised optional field kept", and every clip-resolution fixture case
- [x] 3.3 Add `exportSongMidi` to `lib/api.ts` and Studio toolbar actions Download MIDI, Download project, Open project (id regeneration on collision, error display); verify RTL tests for download filename, "Duplicate id kept separately", and failed export leaving the song unchanged

## 4. Integration checks

- [x] 4.1 Add a Playwright test: build a two-track song where one track repeats a loop in two clips, download the project, open it as a new song, and download MIDI; verify the MIDI file parses with `@tonejs/midi` into 3 tracks with expected channels and the repeated notes at both clip positions
- [x] 4.2 Run `just lint` and `just test`; verify both pass
- [x] 4.3 Manually import an exported three-track song into Logic Pro; record the result and the CC7 behavior note in `backend/README.md`
- [x] 4.4 Run `openspec validate add-song-export --strict`; verify it passes
