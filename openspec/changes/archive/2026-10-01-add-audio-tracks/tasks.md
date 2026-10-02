# Tasks

## 1. Song document and backend validation

- [x] 1.1 Confirm that `add-track-sound-controls` has `InsertChain` wired in `engine.ts` (sources route through `chain.input`). Verify by reading `engine.ts` and running `pnpm vitest engine`.
- [x] 1.2 Add the `Sample` and `AudioClip` types, `Song.samples`, `Track.audio_clips`, and the `TrackInstrument::{Instrument, Audio}` branch for the reserved `audio` id (D1, D2) in `backend/crates/music/src/song.rs`. Run `just gen-types` and update the schema snapshot. Verify that `cargo test -p music` passes.
- [x] 1.3 Add audio validation: sample and clip references, ranges, slice and loop rules, overlap at tempo, the 128-measure limit, no notes or loops on audio tracks, no audio clips on instrument tracks, and `sound.tone` invalid on audio. Add cases to `fixtures/song_validation.json`. Verify with `cargo test -p music`, covering "Clip outside its sample", "Unknown sample", and "Tone knobs on audio rejected".
- [x] 1.4 Skip audio tracks in `song_midi.rs` without advancing channels, exclude them in `context.rs` and the chat, and reject an audio generation target with `400`. Verify with `api/tests/songs.rs` "Audio tracks left out", `track_generation.rs` "Generate on an audio track refused", and `chat.rs` "Chat ignores audio tracks".
- [x] 1.5 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`. Verify that both pass.

## 2. Frontend model, storage, and library

- [x] 2.1 Mirror the audio validation in the TS song checks using the shared fixtures. Include audio clip ends in `derivedMeasures`/`normalizeSong` (D2), and add the `setTempo` 128-measure refusal. Verify with `projectFile.test.ts`, `songOps.test.ts` "Song grows with a sample", and a tempo-limit test.
- [x] 2.2 Add `audioClipOps`: add an audio track, move with snapping and the neighbour stop, trim the start keeping alignment, trim or extend the end with loop rules, toggle loop, gain, fades, duplicate, delete, replace sample, and placement with `samples` bookkeeping. Verify with `audioClipOps.test.ts` covering every "Editing audio clips" and "Placing samples on tracks" scenario.
- [x] 2.3 Implement `sampleStore` (D4), content-hash ids in a worker (D3), waveform overviews, `sampleLibrary`, and reference-counted `collectGarbage` (D5), wired into song open, delete, and duplicate and library remove. Verify with fake-indexeddb tests: "Survives reload", "Undo keeps audio available", "Shared between songs", "Freed when unused", and the same file imported twice storing one copy.
- [x] 2.4 Implement the import pipeline: decode, downmix more than two channels, size and length checks, the storage space check, per-file progress, and per-file errors. Verify with tests for "Import a WAV loop" and "Unsupported file skipped", plus a too-long file and a 4-channel file.
- [x] 2.5 If `add-user-accounts` has merged, treat the `songbird-samples` store as per-user: register it in `lib/auth/perUserStores.ts` so `signOutLocally()` clears it (see `add-user-accounts` design D10). Verify that the registry scan test passes and a sign-out leaves no samples behind. (N/A: `add-user-accounts` not merged when this change was applied; revisit there.)

## 3. Playback and mixdown

- [x] 3.1 Add the audio-clip scheduler path (D6) with pooled players, looping slices, gain and fades, routing into the track InsertChain, and start, seek, and loop-wrap handling. Extend `songPlaybackModel`. Verify with `engine.test.ts`: "Start inside a clip", "Looping clip repeats seamlessly" (an offline render shows no discontinuity at the repeat), mute and solo, and an offline alignment test within 1 ms.
- [x] 3.2 Implement the segmented `Tone.Offline` mixdown (D9) with progress, cancel, the snapshot, tail trimming, worker WAV encoding, and the clip warning. Verify with tests for "Mixdown includes audio tracks", "Muted track left out", "Cancel", and a segmented-vs-whole RMS difference below −60 dB.

## 4. Studio UI

- [x] 4.1 Have `ui-designer` design the audio lane clip (waveform, gain line, fade handles, trim edges, loop repeat marks, and the missing state), the dock audio clip panel, the Samples panel (search, preview, rename, remove, and drag affordance), and the drop-target feedback. Verify that the design spec is delivered before tasks 4.2–4.4.
- [x] 4.2 Add "Audio" to Add Track, the audio track's options-menu "Import audio…", audio lanes with all editing interactions and accessible names, and the empty-lane hint. Verify with `StudioPage.test.tsx` cases for "Add an audio track", "Waveform follows gain", "Trim the start", "Extend a loop", "Move stops at a neighbour", and "Undo a fade".
- [x] 4.3 Build the dock audio clip panel, with gain, fades, loop, and Replace sample. Hide "Generate part with AI" on audio tracks. Verify with Vitest "Edit gain from the panel" and "No generate menu item".
- [x] 4.4 Build the Samples panel (D7, D8) with drag sources, lane and below-lane drop targets, keyboard placement, and previews. Verify with Vitest for "Search", "Preview while playing", "Remove a sample used by a song", "Drag a sample to a lane", "Drop a file below the lanes", "Keyboard placement", and "Overlap refused".
- [x] 4.5 Run `pnpm lint`, `tsc`, and `pnpm build` in `frontend/`. Verify that all pass.

## 5. Export and bundles

- [x] 5.1 Add "Download WAV" to `SongFileActions`. Verify with a `SongFileActions.test.tsx` case that the download is named `songbird-<slug>-<bpm>bpm.wav`.
- [x] 5.2 Implement project bundles (D10) with `fflate`: download a `.songbird.zip` when samples exist, and import with header checks, reuse of existing ids, and library adds. Verify with `projectFile.test.ts` "Round trip with audio", "Missing audio file", and "Bundle adds to the library".

## 6. Integration

- [x] 6.1 Add a Playwright test with a small WAV fixture:
  - import it through the Samples panel;
  - drag it onto a new audio lane;
  - loop-extend it and undo;
  - reload and check that it still plays (the player starts);
  - download a project bundle and a WAV.

  Verify with `just test-e2e`.
- [x] 6.2 Note for archive: update `songs/multitrack` "Song document" to mention the reserved `audio` id (D1). Verify that the note is in the PR description.
- [x] 6.3 Run `just lint` and `just test`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
