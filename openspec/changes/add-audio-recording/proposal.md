# Proposal

## Why

Songwriters want vocals, guitar, or anything else they can put in front of a microphone or plug into an audio interface, recorded in time with the arrangement. `add-audio-tracks` provides the audio tracks, clips, sample storage, playback, editing, and export. This change adds the missing piece, which is filling an audio track from a live input.

## What Changes

- **Recording.**
  - With an audio track selected, the existing Record control (button and `R` key, count-in, metronome, and punch in and out) records from the track's input. It doesn't need MIDI.
  - Each audio track gets an input picker (device and mono or stereo) and a live input level meter that holds a clip indicator.
  - The browser's voice processing is turned off.
  - Recorded audio is placed by compensating for reported input and output latency, plus a user-adjustable recording offset.
- **Takes.**
  - Each recording is stored as a song sample with origin `recording`, tied to its track, and placed as a clip.
  - Recording over existing audio replaces it only in the recorded span.
  - With looping on, every pass is kept as a separate take, and the clip plays the latest one.
  - A Takes list in the audio clip panel switches, renames, deletes, or adds takes to the sample library.
  - Each recording session is one undo step.
- **Input monitoring.** A per-track Monitor toggle sends the live input through the track's effects, volume, and pan, with a headphones warning. Recordings stay dry.
- **Out of scope:** recording several tracks at once, automatic latency calibration, and comping inside a clip.

## Capabilities

### New Capabilities
- `songs/audio-recording`: input selection and permission, level metering, recording takes onto audio tracks (latency compensation, loop passes, replacing existing audio), recorded samples in the song document, the Takes list, the recording offset, and input monitoring.

### Modified Capabilities
- `patterns/midi-input`: Record is no longer disabled without MIDI when an audio track is selected in the Studio.

## Impact

- **Frontend:**
  - New `lib/audio/recorder` (an AudioWorklet capture node, the input device manager, and the level meter).
  - Latency-compensated placement in `engine.ts`.
  - Monitoring routing into the track `InsertChain`.
  - `createAudioTake` as a new `TakeTarget`, with Record enablement by selected track.
  - The audio track header (input picker, meter, Monitor).
  - A Takes list in the foundation's audio clip panel.
- **Backend:** `music::song` accepts sample `origin: "recording"` with `track_id`, plus validation and fixtures.
- **Depends on:** `add-audio-tracks`, which must merge first.
