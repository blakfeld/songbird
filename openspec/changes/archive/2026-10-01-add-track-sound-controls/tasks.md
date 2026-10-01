# Tasks

## 1. Song document and validation

- [x] 1.1 Add `TrackSound`, `Tone`, and `Effects` (eq, distortion, chorus, delay, reverb) to `backend/crates/music/src/song.rs` as optional fields per design D1. `Track.sound` uses `#[serde(default, skip_serializing_if)]` and `#[ts(optional)]`. Set `sound: None` in the `chat.rs` and `context.rs` Track literals. Verify that `cargo build` passes and that the schema snapshot test is updated with `cargo insta review` or the project's snapshot flow.
- [x] 1.2 Add range and instrument-kind validation for `sound` to `validate_track`, with messages naming the track and the setting. Add matching cases to `fixtures/song_validation.json` (an out-of-range value, a melodic-only field on drums, a drums-only field on melodic, and a bad delay `time`). Verify with `cargo test -p music`.
- [x] 1.3 Run `just gen-types` and add the same checks to `frontend/src/lib/song/projectFile.ts` and the library's load validation, driven by the shared fixtures. Verify that `projectFile.test.ts` and `migrate.test.ts` pass, including an unknown field inside `sound` being kept.
- [x] 1.4 Add a song-export integration test showing that the MIDI output is identical with and without `sound` (`backend/crates/api/tests/songs.rs`). Verify with `cargo test -p api`.
- [x] 1.5 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`. Verify that both pass.

## 2. Song operations and undo

- [x] 2.1 Implement `setSound(song, trackId, patch)` (deep merge, `null` deletes, same object on no-op) and `resetSound` in `lib/song/songOps.ts`. Verify with `songOps.test.ts` cases for merge, delete, and no-op identity.
- [x] 2.2 Add store actions using the existing gesture mechanism (one undo step per drag, toggle, choice, and reset). Verify with `songStore.test.ts`: a drag gives 1 step, a drag back to its start gives 0 steps, and reset gives 1 step.
- [x] 2.3 Make sure chat, Add Track, Send to song, and generation create tracks without `sound`, and that generation into an existing track keeps it. Verify with tests in `songStore.test.ts` and `StudioPage.generate.test.tsx`.

## 3. Audio engine

- [x] 3.1 Move the overlapping preset effects into `SynthPreset.defaults` (bass and strings filter cutoff, envelopes), keeping the piano reverb and pad chorus as fixed voice character (D4). Verify with a `presets.test.ts` equivalence case: an empty `sound` builds the same node types and parameters as before.
- [x] 3.2 Add `ToneControls` to the synth and drum sources: live envelope `set`, filter cutoff and resonance with ramps, and drum pitch via `playbackRate` at trigger. Verify with `synthSource.test.ts` and `drumsSource.test.ts` using the mocked Tone.
- [x] 3.3 Build the per-track InsertChain in `engine.ts`:
  - lazy nodes
  - wet ramps for enable and disable
  - EQ bypass by zero gains
  - delay time from note values against the transport BPM, updated on tempo change
  - debounced reverb decay with a crossfade

  Wire it into `makeEntry` and an `applySound` diff next to `applyMixer`. Add `sound` to `Voice` and resolve it in `songPlaybackModel.ts`. Verify with `engine.test.ts` cases: no nodes created for an absent sound, enabling ramps wet, delay time at 120 and 60 BPM, and live changes not restarting playback.
- [x] 3.4 Route `previewVoice` through the track's InsertChain with its own ToneStage (D3). Verify with an `engine.test.ts` case where a preview on a reverb-enabled track connects into that track's chain.
- [x] 3.5 Run a manual performance and listening check: 16 tracks with all effects on play without glitches on a typical laptop, and default-sound tracks sound unchanged from `main`. Record the results in the PR description.

## 4. Knob and Sound panel UI

- [x] 4.1 Have `ui-designer` produce the Sound panel layout (popover on desktop, bottom sheet on narrow screens), the knob size, effect on/off affordance, and the track header Sound button. Verify that the design spec is delivered and agreed before task 4.3.
- [x] 4.2 Generalise `PanKnob` into `Knob` (D6), with linear and log scales, format, default, keyboard, double-click, Delete, and the value readout. Re-implement `PanKnob` on top of it. Verify that the existing `PanKnob` tests pass unchanged and that new `Knob.test.tsx` cases cover log mapping, keys, and reset.
- [x] 4.3 Build `TrackSoundPanel`:
  - a Tone group filtered by instrument kind;
  - five effect groups in chain order, each with an on/off switch;
  - a delay-time selector;
  - "Reset sound".

  Add the Sound control to `TrackHeader.tsx`, with one panel open at a time and non-modal. Verify with Vitest tests for each "Sound panel" and "Knob control" scenario.
- [x] 4.4 Run `pnpm lint`, `tsc`, and `pnpm build` in `frontend/`. Verify that all pass.

## 5. Integration

- [x] 5.1 Add an e2e test in `e2e/studio.spec.ts`:
  - open a track's Sound panel;
  - turn Delay on and change a knob with the keyboard;
  - undo;
  - reload and confirm the settings persisted;
  - download the project and confirm `sound` is in the file.

  Verify with `just test-e2e`.
- [x] 5.2 Run `just lint` and `just test`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
