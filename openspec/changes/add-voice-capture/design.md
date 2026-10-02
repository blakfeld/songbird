# Design

## Context

See proposal.md for the motivation. This change builds on the following existing pieces.

**Audio capture (`frontend/src/lib/audio/recorder/`):**
- `recordingInput.ts` opens the input with echo cancellation, noise suppression, and AGC off.
- `recorderTap.ts` streams `RecorderChunk { frame, channels }` from the same-origin worklet `public/worklets/recorder.js`. The worklet is loaded on the native context because the CSP blocks Tone's blob-URL worklets.
- `placement.ts` turns a context frame into song seconds, using `TakeOrigin` and `totalLatency` (output + base + input + user offset). It is the existing latency-compensation contract.

**Audio takes (`lib/recording/audioTake.ts`):**
- It handles count-in, limits, storing PCM via `sampleStore.putSample` with GC pinning, and writing the take with `song/audioClipOps.recordTake`.
- A take's sample has `origin` `"recording"`, `track_id`, and `recorded_at_ticks`.

**Note quantizing:**
- `lib/recording/take.ts` `quantizeNote` works on `MappedStep`s.
- The engine's `stepAt` maps transport time to swing-aware steps (`lib/timing.ts` mirrors Rust `step_to_seconds`).

**Range write-back:** `songStore.applyGeneratedRange` (backed by `clipOps.applyGeneratedRange`) writes range-relative notes as a new loop and one clip. It shortens or splits overlapped clips and never changes existing loops.

**Song key:**
- `Song.key` always exists (it defaults to C major; `songs/multitrack`).
- `lib/music/key.ts` already has `scalePitchClasses`.

**Workers:** `lib/audio/sampleAnalysis.worker.ts` shows the module-worker pattern that works under the CSP.

**Chat backend (`backend/crates/music/src/`):**
- `chat.rs` has `ChatBody` (line 40) and `ValidChat::range_for` (line 123).
- `context.rs` owns context rendering and trimming. Its test `trimming_drops_the_farthest_measures_then_the_latest_tracks` (line 524) pins today's order.

## Goals / Non-Goals

**Goals:**
- All DSP is deterministic, pure TypeScript, and unit-testable against synthetic signals (sine sweeps, clicks, filtered noise). No new dependency is needed.
- Analysis runs once per capture. Moving the clean-up controls only re-runs the cheap stages, so the preview updates instantly.
- Reuse the audio-take machinery for input, placement, and storing the kept original, so latency behaves exactly as audio recording does.

**Non-Goals:**
- Real-time note entry while humming. The live display is informational only, and notes are produced after capture ends.
- Per-user trained classifiers or ML models. See the open questions.
- Changing how normal audio or MIDI recording works.

## Decisions

### D1. Pitch detection: in-house YIN with pYIN-style smoothing, in a worker
We considered the following options:

| Option | Accuracy on voice | Size | Notes |
|---|---|---|---|
| Plain autocorrelation | Octave errors common | ~50 lines | Too error-prone on hums |
| **YIN** (de Cheveigné & Kawahara 2002) | Good, with a few octave errors | ~150 lines | Has an aperiodicity measure that gives voicing for free |
| McLeod MPM (`pitchy`) | Similar to YIN | Small dependency | No clear win over YIN, and adds a dependency |
| pYIN (Mauch & Dixon 2014) | Best classical method | More code | Uses an HMM over pitch candidates with Viterbi decoding |
| CREPE / Spotify basic-pitch (tfjs) | Best | Model is several MB, plus tfjs | Heavy download, WebGL variance, and tfjs needs CSP review |

**Choice:** YIN on a mono, 16 kHz downsampled signal.
- The window is 1024 samples (64 ms, enough for C2 at 65 Hz) with a 160-sample hop (10 ms).
- The difference function is computed through FFT autocorrelation, so a 32-measure capture of about 3 minutes analyses in well under 2 seconds.
- Threshold 0.15 with parabolic interpolation.

Smoothing follows pYIN:
- Keep up to three YIN candidates per frame.
- Run a Viterbi pass over a 20-cent pitch grid plus an unvoiced state, with a transition cost proportional to the interval.

The Viterbi pass is what suppresses octave errors and short dropouts without the full probabilistic pYIN. RMS below an adaptive floor (the 10th percentile plus 12 dB, with an absolute minimum) forces the frame unvoiced. This is what makes breath and room noise produce no notes.

*Why not ML now:* the spec only promises monophonic voice in C2–C6, which classical methods handle well. A model would be a large download and a CSP and WebGL risk, and it would add nothing for the cases we commit to. The detector sits behind a `PitchTracker` interface, so basic-pitch can be swapped in later without spec changes.

### D2. Note segmentation
The input is the smoothed f0 track (fractional MIDI per 10 ms frame) plus an onset strength curve (positive RMS flux). The segmenter splits as follows:
- on voiced and unvoiced transitions;
- on a pitch change of more than 0.6 semitones that persists for 60 ms or more. This is a median-filtered comparison, so ±50-cent vibrato never splits a note.
- on an onset peak inside a voiced region whose flux is more than 2× the local median. This catches re-sung syllables on the same pitch.

Each segment's pitch is the median of its frames, rounded to the nearest semitone after the octave fit (D5). Its loudness is the RMS over its first 100 ms, which drives velocity.

### D3. Tap analysis: spectral-flux onsets plus a rule-based classifier
Onset detection runs at the native rate:
- STFT with a 1024-sample window and a 256-sample hop;
- half-wave rectified log-spectral flux;
- an adaptive threshold of the moving median plus δ, where δ is driven by Sensitivity;
- a minimum gap of 40 ms between onsets.

A peak's time is refined back to the sample domain by searching the 256 samples before it for the envelope's steepest rise. This keeps hits within the ±10 ms the latency scenario needs.

Classification uses four features computed over 80 ms after each onset:
- low-band energy ratio (<150 Hz);
- high-band ratio (>5 kHz);
- spectral centroid;
- decay time to −20 dB.

The rules are:
- **Kick:** low ratio > 0.5, or centroid < 300 Hz.
- **Hat:** high ratio > 0.4, and centroid > 4 kHz. A hat whose decay is ≥ 120 ms is open, otherwise closed.
- **Snare:** everything else.

The thresholds live in one constants table that is tuned against the fixtures in D9.

*Alternative:* k-nearest-neighbour against a user calibration step ("make your kick sound 4 times"). This is more accurate for unusual voices, but it adds a flow before the first capture. It is deferred (see Open Questions). Classification is isolated, so adding it later does not change the spec.

Sensitivity is monotonic (spec) because it only moves δ. Onsets are detected once at the lowest threshold, each with its strength, and the preview filters them by strength.

### D4. One analysis, many previews
The worker returns an intermediate result that is independent of every control:
- for Hum: the f0 track, onset curve, and RMS;
- for Tap: onsets with strength and class.

Segmentation, filtering, quantizing, key snapping, and the octave fit (D5) are pure functions on the main thread in `lib/capture/convert.ts`. They take `(analysis, controls, songTiming, instrument)` and return range-relative `Note[]`. They run in under 5 ms for 32 measures, which meets the 100 ms preview requirement without a worker round trip.

### D5. Octave fit, key snap, quantize order
The conversion runs in this order:
1. Segment (D2).
2. Blip removal. The threshold is in seconds, because it is applied before the grid exists.
3. Octave fit: choose the whole-octave shift k ∈ [−3, 3] that maximizes the count of in-range notes, breaking ties by |k|. Then fold the remaining outliers.
4. Key snap, on the fractional median pitch, so that "nearer the sung pitch" can be decided.
5. Timing quantize. A start's song seconds are mapped to fractional steps through the swing-aware inverse of `stepToSeconds`. It is pulled toward the nearest grid line by the Clean-up fraction, then rounded to an integer step.
6. Gap closing.
7. Monophonic enforcement: shorten each note to the next note's start.
8. Clamp to the range.

Key snap comes before quantize because pitch and time are independent. Gap closing comes after quantize so that it works in steps.

The swing-aware fractional mapping is new. `stepAt` only returns integers, so `lib/timing.ts` gains `secondsToFractionalStep`, which is tested against `fixtures/timing.json`.

### D6. Capture session reuses the audio-take pipeline
`lib/capture/captureSession.ts` composes the following:
- `openRecordingInput` (or a keyboard listener for Keys);
- `createRecorderTap`;
- the engine's count-in and start;
- `TakeOrigin` and `Latencies` from `placement.ts`.

It does not create a take on a track. It buffers chunks in memory, capped at 32 measures (and bounded at about 3.2 minutes at 40 BPM in 4/4). It then hands the mono downmix to the worker.

The live note readout during Hum runs a lightweight YIN on the last 1024 samples every 50 ms in the same worker. The readout is display-only, so its accuracy does not matter.

Keys capture timestamps `KeyboardEvent.timeStamp`. It converts to context time with `AudioContext.getOutputTimestamp()` and subtracts `outputLatency` plus the user offset. Input latency is excluded, because there is no audio input path.

### D7. Commit is one store action
`songStore.commitCapture({ target, range, notes, keepOriginal, pcm })` runs in one history entry:
1. Create the target track if it is new.
2. Run `clipOps.applyGeneratedRange` with the loop name "Hummed idea" or "Tapped beat".
3. If `keepOriginal` is set:
   - create the "(voice)" audio track directly below the target, muted;
   - store the PCM through the same `putSample` and `pinSample` path as `audioTake.ts`;
   - write the clip with `audioClipOps.recordTake`, using `placeTake` for `start_ticks` and `offset_samples`.

The PCM is stored **before** the history entry, and is unpinned once the song names it. This is the same ordering `audioTake.ts` uses, so a failed store aborts the commit without leaving a half-applied song.

The limit checks (tracks, samples, takes) run before capture starts, using the worst case ("Keep original" on). They are rechecked at commit time, because the user may have changed the song while previewing.

*Alternative:* write the result through the MIDI recording path (`songTake.ts`) so that notes merge into existing clips. This was rejected because merging a whole phrase into a linked loop changes every clip that shares it. The generation write-back's "new loop, replace range" behavior is what users already know from AI parts.

### D8. Anchor track in the chat backend
- `ChatBody` gains `anchor_track_id: Option<String>`. `ValidChat` resolves it to a track index, or rejects it with `invalid_track`; this is a 400 under the chat endpoint's body rules.
- `range_for` adds one branch after `named_measures`: if the anchor's clip span is at most 32 measures, return it.
- `context.rs`:
  - The track summary takes an optional anchor index.
  - It renders the anchor first, under an `ANCHOR` label inside the same escaped block, and includes it even if muted.
  - The trimming loop skips the anchor until every other track is empty.

With no anchor, the output is byte-identical, which protects the existing snapshot tests.

Because the frontend sends the anchor only on the next message, the chat hook holds `pendingAnchor` in component state, not in the song. It is cleared on send or on removal.

### D9. Test fixtures are synthesized, not recorded
`frontend/src/lib/capture/fixtures.ts` generates the test signals:
- sine and sawtooth tones with vibrato, plus noise floors and glides;
- clicks;
- band-limited noise bursts (low-passed for kick, band-passed for snare, high-passed for hat, with controlled decays).

Every spec scenario is asserted on these signals in Vitest. A small set of real recordings (about 10 clips, under 1 MB, CC0 and recorded by us) lives in `frontend/test-fixtures/capture/`. These are used for a tolerance test with ≥ 85% note and hit agreement, so that thresholds are not tuned only to synthetic sounds.

For Playwright, Chromium's `--use-file-for-fake-audio-capture` feeds a WAV of a sung phrase, so the whole flow runs end to end.

### D10. UI placement
The capture panel opens in the editor dock area (`EditorDock.tsx`) as a "Capture" tab, not as a modal. This keeps the arrangement visible for timing context. The preview reuses the read-only rendering of the piano roll grid. `ui-designer` reviews the panel before it is built (tasks 4.1).

## Risks / Trade-offs

- **[Risk]** Speaker bleed: the click and song playback leak into the mic. For Tap, this creates false hits. For Hum, the song's melody can be tracked instead of the voice.
  - **Mitigation:** the click-coincidence gate (spec), and a headphones hint shown the first time the user captures with "Play song" on. Echo cancellation stays off, matching recording (see Open Questions).
- **[Risk]** Out-of-tune or breathy singers produce jittery pitches.
  - **Mitigation:** the Viterbi smoothing, Snap to key on by default, and Clean-up. The result is editable anyway.
- **[Risk]** The rule-based drum classifier misreads some voices, for example a snare read as a hat.
  - **Mitigation:** tunable thresholds, the real-recording tolerance test, and easy editing after commit. A calibration step is the follow-up.
- **[Trade-off]** Capture is in-time only. Users who hum freely without a click get a result quantized to the song tempo. Free-tempo capture with tempo detection is out of scope.
- **[Risk]** Memory: 32 measures at 40 BPM and 48 kHz stereo is about 75 MB of float PCM before downmix.
  - **Mitigation:** downmix to mono as chunks arrive (Hum and Tap need only mono), which halves the size. The kept original is stored mono, as a mono take would be.
- **[Risk]** `getOutputTimestamp` support varies for Keys timing.
  - **Mitigation:** fall back to `currentTime` minus `outputLatency`, and cover both paths with a unit test.

## Migration Plan

There are no data migrations:
- Committed results are ordinary loops, clips, tracks, and recorded samples.
- `anchor_track_id` is optional, and older clients never send it.

Rollback: remove the panel. Songs made with it still load, because they use only existing document features.

## Open Questions

- **Chord-tone snapping:** once `add-section-chord-generation` lands, should Snap to key prefer tones of the sounding chord? This would be a follow-up toggle, with no change to this change's spec.
- **Calibration:** should Tap mode offer an optional per-user calibration ("teach your kick, snare, and hat"), stored in the browser? Decide after real-user testing of the rule-based classifier.
- **Echo cancellation:** should capture (not recording) turn on the browser's echo cancellation when "Play song" is on? It may distort transients and pitch. Evaluate with the real-recording fixtures.
- **Sampler targets:** should Tap captures be allowed to target sampler tracks, with hits mapped to the first three pads?
- **ML detector:** should basic-pitch be offered as an opt-in "high accuracy" detector, if the classical tracker proves weak on some voices?
- **Default instrument:** Hum's default instrument is Piano, because it has the widest range. Synth Lead may feel more like a melody line, so revisit this after usage.
