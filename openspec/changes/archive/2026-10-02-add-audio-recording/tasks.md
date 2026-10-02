# Tasks

## 1. Document

- [x] 1.1 Confirm that `add-audio-tracks` is merged (audio tracks, `Song.samples`, `sampleStore`, clip playback, and the audio clip panel). Verify that `cargo test -p music` and `pnpm vitest sampleStore engine` pass on main.
- [x] 1.2 Add sample `origin: "recording"` with `track_id`, and validation (an existing audio track, at most 64 per track), in `backend/crates/music/src/song.rs` and the TS checks, with shared fixtures. Run `just gen-types`. Verify with `cargo test -p music` and `projectFile.test.ts` "Take kept with the song".
- [x] 1.3 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`. Verify that both pass.

## 2. Capture, placement, and monitoring

- [x] 2.1 Add the recorder worklet and input manager (D1): device enumeration, `getUserMedia` with voice processing off, mono or stereo, permission states, the peak stream, and the clip-hold flag. Verify with unit tests using a fake `MediaStream`/worklet port: constraints, a missing device falling back to the default, and a denied permission.
- [x] 2.2 Implement latency-compensated placement (D2) and the recording-offset setting (browser storage, −200..+200 ms). Verify with unit tests for "Latency compensated" (10 ms + 8 ms gives a clap within 5 ms of measure 2) and "Adjust offset".
- [x] 2.3 Implement monitoring (D4): the source → monitor gain → InsertChain path, mute and solo, and dry recording taps. Verify with `engine.test.ts` "Hear yourself with reverb" (the routing graph) and "Monitor muted".

## 3. Recording sessions and takes

- [x] 3.1 Add `replaceSpan` (trim, split, remove) to the foundation's `audioClipOps`. Verify with `audioClipOps.test.ts` "Punch in over an earlier take".
- [x] 3.2 Implement `createAudioTake` (D3):
  - the transient recording overlay;
  - loop-pass splitting at wrap frames;
  - take naming;
  - hashing and storing;
  - one gesture adding samples, `replaceSpan`, and the clip;
  - Record enablement by selected track (`needsMidi`);
  - the 20-minute, take-limit, and no-input refusals.

  Verify with tests for "Record a vocal from stopped", "Three passes", "One undo per session", and a storage-quota failure leaving the song unchanged.
- [x] 3.3 Update Record gating in `useRecordControl`/`Transport`. Verify with Vitest "Record on an audio track without MIDI".

## 4. UI

- [x] 4.1 Have `ui-designer` design the audio track header recording controls (input picker, meter with clip hold, Monitor toggle), the headphones warning, the Takes list in the clip panel, and the recording-offset setting location. Verify that the design spec is delivered before tasks 4.2–4.3.
- [x] 4.2 Build the header controls. Verify with `StudioPage.test.tsx` "Choose an interface input", "Permission denied", and "Clipping shown".
- [x] 4.3 Add the Takes list (switch, rename, delete unused, and add to library) to the audio clip panel and the clip context menu. Verify with Vitest "Switch to an earlier take", "Delete an unused take", and "Add a take to the library".
- [x] 4.4 Run `pnpm lint`, `tsc`, and `pnpm build` in `frontend/`. Verify that all pass.

## 5. Integration

- [x] 5.1 Add a Playwright test using Chromium's fake media device (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--use-file-for-fake-audio-capture` with a click-track WAV fixture): add an audio track, record 2 measures from stopped, check the clip and take, undo and redo, then reload and check that the clip still plays. Verify with `just test-e2e`.
- [x] 5.2 Document the recording setup (input choice, headphones, and the recording-offset clap test) in the README. Verify that the steps work as written in Chrome and Safari.
- [x] 5.3 Run `just lint` and `just test`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
