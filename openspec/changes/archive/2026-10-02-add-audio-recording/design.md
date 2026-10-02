# Design

## Context

- **Foundation:** `add-audio-tracks` provides the audio tracks, the song `samples` with content-hash ids, `sampleStore` and its cleanup, clip playback through the track `InsertChain`, the clip editing ops, the dock audio clip panel, the WAV mixdown, and project bundles. This change only adds a way to fill audio tracks from a live input.
- **Playback:** `lib/audio/engine.ts` uses a step scheduler with `LOOKAHEAD_SECONDS = 0.1`, and the playhead reads the audio clock. `stepAt(domTimeStamp)` compensates MIDI input for `baseLatency + outputLatency`, but there is no input-latency handling.
- **Recording:**
  - `useRecordControl.ts` (`idle | counting-in | recording`, gated by `RECORD_NEEDS_MIDI`) and `useRecordingSession.ts` orchestrate takes through a `TakeTarget` (`begin/add/end/discard`, `lib/recording/take.ts`).
  - `songTake.ts` opens a store gesture, giving one undo step.
  - Count-in, metronome, and loop-wrap events live in the engine.
- **No input capture exists:** no `getUserMedia` and no `AudioWorklet`.

## Goals / Non-Goals

**Goals:**
- Sample-accurate capture on the playback clock, with placement compensated for latency.
- Reuse the record state machine, count-in, punch logic, gestures, insert chain, and the foundation's sample model unchanged.

**Non-Goals:**
- Multi-track simultaneous recording, auto latency calibration, comping inside a clip, and server-side audio.

## Decisions

### D1. Capture via AudioWorklet, not MediaRecorder
- A `RecorderWorklet` (`public/worklets/recorder.js`, loaded with `audioWorklet.addModule`) receives the `MediaStreamAudioSourceNode` input.
- It posts Float32 blocks with the `currentFrame` of each block's first sample, using transferable buffers in 1-second chunks, to the main thread. The main thread appends them to growing chunk arrays.
- The same node computes a peak per 128-frame render quantum and posts peak values at about 30 Hz for the meter and live waveform.
- *Why:* MediaRecorder produces lossy, compressed, variable-latency output with no sample-clock timestamps. The worklet gives raw PCM on the same `AudioContext` clock as playback, which is what makes D4 possible.
- `getUserMedia` constraints are `{deviceId, channelCount: 1|2, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: ctx.sampleRate}`.
- The `AudioContext` is created with `latencyHint: "interactive"`, which is already the Tone default.
- **The Content Security Policy is unchanged.** Tone's `standardized-audio-context` wrapper loads worklet modules through blob URLs, which `script-src` blocks. The worklet is therefore loaded on, and its node built against, the native `AudioContext` beneath Tone's wrapper, so the module loads from `'self'`. Wrapper and native nodes can't be connected, so each input stream gets two sources: a native one feeding the recorder, and a wrapper one feeding the monitor gain and `InsertChain`. That also keeps recordings dry by construction. *Alternative:* adding `blob:` to `script-src`. It was rejected so that recording doesn't weaken the policy.

### D2. Latency compensation and placement
- The recording start is the context frame at which the transport reached the punch-in point. The engine records `{transportSeconds, contextTime}` when the take begins.
- Each captured sample's song time is `(frame/sampleRate − startContextTime) + startTransportSeconds − (outputLatency + baseLatency + inputLatency + userOffset)`:
  - **outputLatency + baseLatency:** what the performer heard was emitted that much after scheduling.
  - **inputLatency:** taken from `track.getSettings().latency` when the browser provides it, otherwise 0.
  - **userOffset:** the browser-stored recording offset.
- The resulting start is converted to `start_ticks` (rounded to the nearest tick), and leading samples before the punch-in point are trimmed through `offset_samples`, so nothing lands before the punch-in.
- *Alternative:* compensating by shifting playback. It was rejected because it would delay everything else.

### D3. Takes and loop recording as a new `TakeTarget`
- `createAudioTake(store, audioStore, trackId, engine)` implements `TakeTarget`. `useRecordingSession` picks it when the selected track is an audio track, and `RECORD_NEEDS_MIDI` becomes `needsMidi(selectedTrack)`.
- **Live drawing:** during the session, the store holds a transient "recording" overlay (not in the song) so the lane can draw the growing take from the peaks stream.
- **Loop passes:** the engine already emits loop-wrap events. On each wrap, the target cuts the capture at the exact wrap frame and starts a new take buffer. The pass boundary is computed in context frames from the transport's wrap time, so passes are gapless and sample-aligned.
- **On end:**
  1. Each pass's PCM is hashed for its id and written to the foundation's `sampleStore`.
  2. Inside one store gesture, recorded `samples` entries (`origin: "recording"`, `track_id`) are added, overlapping clips in the recorded span are trimmed or split (a new `replaceSpan` in the foundation's `audioClipOps`), and one clip is added for the span, playing the last pass.
  3. `endGesture` → one undo step.
- If writing audio fails (quota), the take is discarded, an error is shown, and the song is unchanged.
- **Past the end:** with looping off, an audio take suppresses the transport's stop-at-end, so playback runs on past the last measure. When the take ends, the same gesture extends the song to cover the clip, capped at 128 measures, which is where the auto-stop fires. This keeps a fresh 1-measure song usable for recording. MIDI takes keep the existing stop-at-end.
- **Takes stay in song time:** each recorded sample stores `recorded_at_ticks`, the song position of its first frame after placement. Switching a clip to another take sets `offset_samples` from the clip's song position minus that take's `recorded_at_ticks`, clamped to the take. That way, a punched-in or split clip keeps playing what was recorded at that moment. *Alternative:* deriving the start from the clip that created the take. It was rejected because later edits erase it.
- **Seeks and sliver passes:** with looping off, a seek's `"wrap"` event ends the take instead of starting a pass. A final loop pass shorter than one beat is dropped, so a Stop just after the restart doesn't replace a full pass on the lane.
- **Deleting a track:** `deleteTrack` removes the track's unused takes and turns takes still used elsewhere into imports, so the song never holds a dangling `track_id`.

### D4. Monitoring
- While Monitor is on, the track's `MediaStreamAudioSourceNode` is connected into a monitor `Gain` → the track `InsertChain` input. The connection is made once per track while monitoring, and is independent of the transport.
- The recorder worklet taps the source before the chain, so recordings are dry.
- Mute and solo are applied to the monitor gain through the same audibility logic as voices.
- A one-time headphones warning is stored as a browser flag.

## Risks / Trade-offs

- [Browser-reported latencies are missing or wrong, especially Bluetooth or Firefox `outputLatency`] → The manual recording offset, plus a documented clap test in the README.
- [Main-thread jank while long takes accumulate] → The worklet posts 1 s chunks, which are kept as an array and only concatenated at take end.
- [Feedback with monitoring on speakers] → Monitor is off by default, with a first-use warning.
- [Storage quota during long sessions] → The foundation's space check runs before recording. A failed write discards the take with an error, and leaves the song unchanged.
- [Dependency on `add-audio-tracks`] → Task 1.1 checks that it has landed.

## Open Questions

- Default mono or stereo for a new track's input. The plan is mono, and this can be revisited after user testing.
