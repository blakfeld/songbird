# Design

## Context

- **MIDI export** (`music/src/midi.rs:95`): `pattern_to_midi` validates the pattern, settles overlapping notes per row with `settle`, converts steps to ticks with swing via `step_to_ticks`, and writes a Type 1 file with two tracks: a conductor track and a single note track. The API wraps it at `api/src/patterns.rs` (`export_midi`).
- **Body limit**: a global `DefaultBodyLimit::max(MAX_BODY_BYTES)` (64 KiB) is set in `api/src/routes.rs:16,48`, inside the CORS layer so that `413` responses still carry CORS headers.
- **Song type**: #4 defines `Song`/`Track` as hand-written TypeScript in `frontend/src/lib/song/types.ts`, shaped for Rust. #1 adds `midi_program` and `kind` to instruments.

See proposal.md for motivation and `specs/songs/export/spec.md` for behavior.

## Goals / Non-Goals

**Goals:**
- One source of truth for the song shape. It moves to Rust now because the export endpoint, and later #6, #8, and #9, deserialize it.
- Reuse the pattern exporter's tick math and overlap handling so that song and pattern exports agree note for note.
- Keep project files human-readable and forward-detectable (`format` plus `version`).

**Non-Goals:**
- Server-side validation of project files. Import is browser-only; see D4.
- A Type 0 option, or tempo and meter changes within a song.

## Decisions

### D1. `Song` and `Track` in `music::song`, generated to TypeScript
- **Types:** `music/src/song.rs` defines `Song { version, id, name, tempo_bpm, time_signature, swing, measures, tracks }` and `Track { id, name, instrument, volume_db, pan, muted, soloed, notes: Vec<Note> }`.
  - They derive serde, ts-rs, and `JsonSchema`.
  - `Song` does not use `deny_unknown_fields`, so that later changes (#7 sections, #8 key and chords, #9 lyrics) can add optional fields without breaking older clients. Each later change adds its field here as `Option`/`#[serde(default)]` with `skip_serializing_if`, so songs without it serialize byte-identically.
  - **Versioning policy (applies to #7, #8, #9):** additive optional fields keep the song `version` and the project-file `version` at 1. Each change that adds a field also extends the TypeScript validator in `lib/song/projectFile.ts`, adds valid and invalid cases to `fixtures/song_validation.json`, reruns `just gen-types`, and adds a project-file round-trip test. `version` increases only for a change older builds cannot read correctly. Such a change needs its own design decision and a migration.
  - **Unknown fields** are ignored by Rust validation and preserved by the browser importer, so a file from a newer build that only added optional fields still opens.
- **Validation:** `Song::validate(&InstrumentRegistry) -> Result<ValidSong, SongError>` checks the ranges and rows. Its errors name the offending track by index and name.
  - `ValidSong` carries each track's resolved `&Instrument`. Consumers (export now, generation in #6) therefore never re-resolve rows.
- **Frontend types:** the frontend drops `lib/song/types.ts` in favour of `@/generated/Song` and `@/generated/Track`.
- **Alternative:** keep the TS types and add a separate Rust DTO. That gives two definitions that can drift, which ts-rs exists to prevent.

### D2. Song MIDI builds on the pattern exporter's internals
- **Refactor:** extract the per-track body of `pattern_to_midi` (resolve rows, `settle`, timed on/off events, End of Track) into `fn note_events(rows, notes, total_steps, swing, channel) -> Vec<TrackEvent>`.
  - `pattern_to_midi` keeps its output byte-identical. Its existing tests guard this.
- **Song export:** `song_to_midi(&ValidSong)` builds the conductor track the same way, then one track per song track:
  - `TrackName`;
  - `ProgramChange(midi_program - 1)` for melodic instruments;
  - `Controller 7` and `Controller 10`;
  - then `note_events`.
- **Channels:** assigned by `assign_channels(&[Track]) -> Vec<u4>`, which gives drums channel 10 (index 9) and melodic tracks the next free channel from 1–9 and 11–16.
  - The 16-track cap means at most 15 melodic channels are ever needed. Songs with several drums tracks share channel 10, as General MIDI intends.
- **Mixer mapping:** CC7 and CC10 values are pure functions (`volume_cc`, `pan_cc`), unit-tested at the spec's boundaries.
  - CC7 is set so that 0 dB = 100, using GM's 40·log10 curve rather than 20·log10. Most DAWs map CC7 near that curve, and the choice leaves headroom for boosts.
- **Alternative:** write the song as N calls to `pattern_to_midi` and merge. The conductor track would be duplicated, and splicing SMF tracks is fiddlier than sharing the event builder.

### D3. Per-route body limit
- **Routing:** `routes.rs` wraps the songs and lyrics routers (`/api/v1/songs/*` now, `/api/v1/lyrics/*` from #9) in their own `DefaultBodyLimit::max(SONG_MAX_BODY_BYTES)` (1 MiB). The existing 64 KiB layer stays on everything else.
- **Layer order:** the order stays as it is (the limit sits inside CORS), so `413` responses keep carrying CORS headers.
- **Why 1 MiB:** the densest realistic song (16 tracks × 128 measures) serializes to a few hundred KiB, and the lyrics request in #9 is capped at about 100 KiB.
- **Constant:** #9 reuses the constant rather than adding its own number.
- **Alternative:** raise the global limit. That would weaken the protection on the pattern routes, which never need it.

### D4. Project files are validated in the browser only
- **Serialization:** `lib/song/projectFile.ts` serializes `{format, version, song}`. Its `parseProjectFile(text, instruments)` returns `{ok: Song} | {error: string}` and checks:
  - format and version;
  - instrument ids against the cached `GET /api/v1/instruments` list;
  - ranges and rows, mirroring `Song::validate`.
- **Parity:** a shared fixture, `fixtures/song_validation.json`, holds valid and invalid songs with expected error kinds. Both Rust and Vitest consume it, which keeps the two validators in lock-step, the same way `fixtures/timing.json` does for timing.
- **Why client-side:** persistence is browser-only by product decision, and posting the file to the server just to validate it would add a round trip and an endpoint for no user benefit.
- **Id collisions:** the imported song's id is regenerated when it collides.
- **Size limit:** the 5 MB limit is checked before the file is read into memory.

## Risks / Trade-offs

- [Rust and TypeScript validators diverge] → The shared fixture is consumed by both test suites (tasks 1.3 and 3.2).
- [DAWs interpret CC7 differently] → This is documented in `backend/README.md` beside the existing Logic import notes, and the manual Logic check is task 4.3.
- [Replacing the hand-written TS types churns #4's imports] → It is a mechanical import rename. `pnpm typecheck` catches every site.
- [Very large songs approach 1 MiB] → The export returns `413 payload_too_large`, and the Studio shows the standard error. At the 16-track and 128-measure caps the practical maximum stays well under the limit (estimate recorded in task 2.4).
