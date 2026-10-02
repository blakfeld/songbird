# Tasks

## 1. Analysis core (pure TypeScript, `frontend/src/lib/capture/`)

- [ ] 1.1 Add `fixtures.ts` with synthetic signal generators: tones with vibrato and glides, noise floors, clicks, and low-, band-, and high-passed noise bursts with set decays (D9). Verify with Vitest tests that the generators are deterministic for a fixed seed.
- [ ] 1.2 Implement `pitchTracker.ts`: YIN on mono 16 kHz audio through FFT autocorrelation, keeping up to three candidates per frame, followed by Viterbi smoothing with an unvoiced state and an adaptive RMS floor (D1). Verify with Vitest tests on the fixtures:
  - steady tones from C2 to C6 resolve to the nearest semitone;
  - noise and silence are unvoiced;
  - a 40 ms octave glitch is removed;
  - a 3-minute signal analyses in under 2 s under Node.
- [ ] 1.3 Implement `segmenter.ts` (D2). Verify with Vitest tests for the following spec scenarios: "Vibrato stays one note", "Repeated syllables", and a pitch change held under and over 60 ms.
- [ ] 1.4 Implement `onsets.ts` (spectral flux with sample-domain refinement, onsets detected once with their strength) and `drumClassifier.ts` (feature rules and constants table) (D3). Verify with Vitest tests:
  - "Basic beatbox" built from noise bursts;
  - "Long hat";
  - hits less than 40 ms apart merge into one;
  - onset time error under 10 ms;
  - "Sensitivity is monotonic", as a property test over random thresholds;
  - the click-coincidence gate drops weak hits on click times and keeps strong ones.
- [ ] 1.5 Add `secondsToFractionalStep` to `frontend/src/lib/timing.ts` as the swing-aware inverse of `stepToSeconds` (D5). Verify with a Vitest test that round-trips every case in `fixtures/timing.json`.
- [ ] 1.6 Implement `convert.ts`, which runs blips, octave fit, key snap, quantize, gap close, monophonic, and clamp in the D5 order, and drum dedupe and 1-step lengths. Verify with Vitest tests for each spec scenario under "Hum to notes" and "Clean-up and preview": "Three sung notes", "Low voice on a lead instrument", "Full clean-up locks to the grid", "No clean-up keeps the feel", "Snap to key" (including the tie rule), velocity ranges, and no overlapping notes. Also verify that a 32-measure conversion runs in under 5 ms.
- [ ] 1.7 Add `capture.worker.ts`, a same-origin module worker that runs full analysis and the live pitch readout, with a `captureClient.ts` wrapper modelled on `sampleAnalysisClient.ts`. Verify with a Vitest test through a worker shim that the client returns the same result as calling the analysis directly, and confirm that no CSP change is needed by running the existing `securityHeaders.test.ts`.
- [ ] 1.8 Record 10 or so short CC0 hum and beatbox clips into `frontend/test-fixtures/capture/` (under 1 MB in total) with expected notes and hits, and tune the constants (D9). Verify with a Vitest tolerance test that agreement is at least 85%.

## 2. Capture session

- [ ] 2.1 Implement `lib/capture/captureSession.ts` with the following (D6):
  - count-in and start through the engine, ignoring the loop region;
  - an in-memory mono buffer fed by `recorderTap`;
  - the 32-measure auto-stop;
  - `TakeOrigin` and `Latencies` from `placement.ts`;
  - a captured range of the start measure through the measure in which capture ended, which may extend past the song end.

  Verify with Vitest tests using fake taps and engines:
  - "Capture four measures";
  - "Automatic end";
  - "Latency compensated" (10 ms output + 8 ms input);
  - the song document is unchanged after a capture.
- [ ] 2.2 Implement Keys capture: the F/Space, J, K, and L mapping; ignoring key repeat; live drum sound; timestamps converted via `getOutputTimestamp` with the `currentTime − outputLatency` fallback; and only output latency plus the user offset subtracted. Verify with Vitest tests for "Tap a rock beat", "Held key", both clock paths, and a check that Studio shortcuts (for example `R`) do not fire during a Keys capture.
- [ ] 2.3 Add pre-capture limit checks (tracks, samples, takes, assuming "Keep original" is on) and a commit-time recheck. Verify with Vitest tests that a capture is refused with a reason at 16 tracks and at 256 samples.
- [ ] 2.4 Add a privacy guard test. Run a full capture and conversion with `fetch` and `XMLHttpRequest` stubbed to throw, and verify with Vitest that no request is made. Also verify that closing the panel without committing leaves `sampleStore` unchanged ("Cancelled capture leaves nothing behind").

## 3. Commit

- [ ] 3.1 Add `songStore.commitCapture` (D7). It creates the target track if needed, writes through `clipOps.applyGeneratedRange` with "Hummed idea" or "Tapped beat" names and numbering, and, when "Keep original" is on:
  - stores PCM via `putSample` and `pinSample` before the history entry;
  - adds a muted "<name> (voice)" audio track directly below the target;
  - places the clip with `placeTake` and `recordTake`.

  It is one history entry. Verify with Vitest tests for:
  - "Hum into a new track", where one undo removes both tracks;
  - "Tap into the existing drums", where "Groove A" is unchanged;
  - "Track limit", including the message about unchecking "Keep original";
  - a failed store aborting with the song unchanged;
  - the kept sample having `origin` `"recording"`, `track_id`, and `recorded_at_ticks`;
  - the song still validating with `fixtures/song_validation.json` rules.
- [ ] 3.2 Verify with a Vitest test that a committed capture survives a reload and a project bundle round trip, with the kept original's audio included in the bundle.

## 4. Capture panel UI

- [ ] 4.1 Have `ui-designer` produce a layout spec for the Capture dock tab (D10) covering:
  - the mode switch, target and input pickers, and the Click and Play song toggles;
  - the live level and note readout;
  - the preview grid with Grid, Clean-up, Snap to key, and Sensitivity controls;
  - the Original toggle, Retake, and Commit;
  - the Keys mapping legend;
  - the empty-result and refusal states;
  - accessibility (announcements and keyboard operation).

  Verify that the spec has been delivered and agreed before task 4.2 starts.
- [ ] 4.2 Build `components/studio/capture/CapturePanel.tsx` and the "Capture idea" transport control, with the mode and input remembered in this browser, permission handling that reuses `AudioInputContext`, and Keys staying available when the mic is denied. Verify with React Testing Library tests for "Open in Hum mode", "Selected drums track offered for Tap", "Microphone denied", and that the panel is absent on single-instrument pages.
- [ ] 4.3 Build the preview: read-only grid rendering, controls wired to `convert.ts`, Play looping the range on the target instrument with or without the song, and the Original toggle playing the PCM at its compensated position. Verify with React Testing Library tests for "Instant update" (no new capture; preview re-rendered), "Compare with the original" (engine receives the audio source and not the notes), Retake, and Commit disabled with the "nothing detected" message on an empty result.
- [ ] 4.4 After a commit, close the panel and select the new clip, opening it in the dock. Verify with a React Testing Library test for "Result is ordinary music": the notes are editable in the dock's piano roll.

## 5. Build around this (backend and frontend)

- [ ] 5.1 Add `anchor_track_id` to `ChatBody` and `ValidChat` in `backend/crates/music/src/chat.rs`, rejecting with `invalid_track` (400) when it names no track or an audio track, and add the anchor branch to `range_for` (D8). Verify with Rust tests for "Range follows the anchor", "Named length wins", a span over 32 measures falling back, and "Unknown anchor" not calling the provider.
- [ ] 5.2 In `backend/crates/music/src/context.rs`, render the anchor first under an `ANCHOR` label (escaped like other user text), include it even when muted, and trim it last. Verify the following with Rust tests:
  - the existing `trimming_drops_the_farthest_measures_then_the_latest_tracks` and the context snapshot tests pass unchanged ("No anchor, unchanged");
  - new tests cover "Anchor kept longest" and "Muted anchor still heard".
- [ ] 5.3 Add an api integration test in `backend/crates/api` posting to `/api/v1/songs/chat` with an anchor using the mock provider. Verify that the response range matches the anchor span and that an unknown anchor returns `400 invalid_track`.
- [ ] 5.4 Run `just gen-types` if any shared types change, then from `backend/` run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`. Verify that both pass.
- [ ] 5.5 Frontend: add the "Build around this" action after commit, a `pendingAnchor` in the chat hook with a removable chip in the chat input, the prefilled message, and `anchor_track_id` in `frontend/src/lib/api.ts` chat requests. Verify with React Testing Library and Vitest tests that:
  - nothing is sent until the user presses Send;
  - the anchor is sent once and then cleared;
  - "Remove the anchor" sends without it.

## 6. End-to-end and checks

- [ ] 6.1 Add `frontend/e2e/voice-capture.spec.ts`. It uses Chromium's fake audio capture with a WAV of a sung A3–C4–E4 phrase and a beatbox WAV, and the mock provider. The test should:
  1. Hum-capture into a new Piano track and check the clip's notes and the muted "(voice)" track.
  2. Undo and check that both tracks are gone, then redo.
  3. Tap-capture into the Drums track.
  4. Keys-capture a beat.
  5. Choose "Build around this" and send, and check that a new track appears over the anchor's range.
  6. Check that no network request carried audio during capture.

  Verify with `pnpm test:e2e`, waiting rather than killing if port 8181 is busy.
- [ ] 6.2 Run `just lint`, `just test`, and `openspec validate add-voice-capture --strict`, and verify that all pass.
