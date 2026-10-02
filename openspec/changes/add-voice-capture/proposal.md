# Proposal

## Why

Most songwriting ideas start as a voice memo: a melody hummed into a phone, or a beat tapped on a table. Songbird can already record audio and MIDI, but a hummed melody stays a waveform that the user must transcribe by hand before any instrument, the piano roll, or the AI can use it. Turning a hum or a tap into editable notes, in time with the song, removes the step where most of those ideas are lost.

Everything this needs is already in place: microphone recording with latency compensation (`songs/audio-recording`), swing-aware quantization of recorded notes (`patterns/midi-input`), the range write-back that track generation uses to place a new loop and clip (`songs/track-generation`), the song key (`songs/multitrack`), and the song chat that builds tracks around existing ones.

## What Changes

- **Capture panel in the Studio:** a "Capture idea" control opens a panel with three modes:
  - **Hum:** sing or hum a melody, which becomes notes on a melodic track.
  - **Tap:** tap, clap, or beatbox, which becomes a drum pattern with kick, snare, and hi-hats.
  - **Keys:** tap computer keys mapped to kick, snare, closed hi-hat, and open hi-hat.
- **In-time capture:** capture runs against the transport with a count-in and click, from the playhead's measure for up to 32 measures. The audio is placed with the same latency compensation and recording offset as audio takes.
- **Local analysis only:** pitch detection (YIN with pYIN-style smoothing), onset detection, and drum-sound classification run in a Web Worker in the browser. No audio is sent to the server, and capture works offline.
- **Preview and clean-up:** before anything changes in the song, the user sees and hears the result and can adjust the following controls. Changes take effect at once, without capturing again.
  - grid;
  - clean-up strength (timing pull toward the grid, removal of short blips, and gap closing);
  - snap to the song key (Hum);
  - sensitivity (Tap).
- **Commit as normal music:** the result is written into a new track, or into the selected compatible track, as a new loop and one clip over the captured range, using the same range write-back as track generation. It is fully editable afterwards.
- **Keep the original:** by default, the recording is also kept as a take on a muted audio track placed directly below, so the user can compare the notes with what they sang. Commit is one undo step.
- **Build around this:** after a commit, a single action prefills the song chat with a request for a part built around the captured track. The chat request gains an optional `anchor_track_id`. When it is present, the chat generates over the anchor track's clip span, and the anchor's notes are the last context to be trimmed.

Non-goals:
- Polyphonic transcription (chords, guitar strumming).
- Free-tempo capture with tempo detection; capture always follows the song's tempo.
- Capture on the single-instrument pages, or into sampler tracks.
- Lyrics transcription from the sung audio.
- Server-side audio processing or machine-learning models.
- Snapping to section chords. This is left for after `add-section-chord-generation` lands; see design.md.

## Capabilities

### New Capabilities
- `songs/voice-capture`: covers the following:
  - the capture panel and its modes;
  - in-time capture and latency compensation;
  - the local-only processing guarantee;
  - hum-to-notes and tap-to-drums conversion;
  - keyboard tapping;
  - clean-up controls and preview;
  - committing the result, keeping the original recording, and the "Build around this" hand-off.

### Modified Capabilities
- `songs/track-generation`:
  - MODIFIES "Context token budget" so that an anchor track's measures are trimmed last;
  - ADDS "Anchor track in song chat" for the optional `anchor_track_id` on the song chat endpoint.

## Impact

- **Frontend:**
  - New `frontend/src/lib/capture/` holding the following modules, all pure and unit-testable:
    - pitch tracker (YIN plus smoothing);
    - note segmenter;
    - onset detector;
    - drum classifier;
    - capture quantizer;
    - key snapper.
  - A `capture.worker.ts`, loaded as a same-origin module like `sampleAnalysis.worker.ts`, so the CSP is unaffected.
  - Capture recording reuses `lib/audio/recorder` (`recordingInput`, `recorderTap`, `placement`).
  - Commit reuses `clipOps.applyGeneratedRange` and the audio-take path in `lib/recording/audioTake.ts` and `song/audioClipOps.recordTake`.
  - New `components/studio/capture/` panel, plus song store actions for committing a capture as one history entry.
  - The chat hook sends `anchor_track_id`.
- **Backend (`music` crate):**
  - `chat.rs` `ChatBody` gains an optional `anchor_track_id`, and `ValidChat::range_for` uses the anchor's clip span when it is set.
  - `context.rs` trimming keeps the anchor track's measures until last.
- **Backend (`api` crate):** validation error code `invalid_track` for an unknown or non-note anchor.
- **Dependencies:** no new npm or crate dependencies. The DSP is written in-house (see design.md D1).
- **Data:** no song document changes. The kept original is an ordinary recorded sample (`origin` `"recording"`) on an ordinary audio track, and the song `version` stays 2.
- **Privacy:** captured audio never leaves the browser through this feature. It is stored only when the user keeps the original, under the existing sample storage rules.
