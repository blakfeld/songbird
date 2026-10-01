# Proposal

## Why

Every instrument in Songbird has one fixed sound. The synth presets, including their built-in reverb, chorus, and filters, are hardcoded in `frontend/src/lib/audio/presets.ts`, and the only per-track controls are volume, pan, mute, and solo. Songwriters can't make a bass darker, push a pad into a hall, or put an echo on a lead, so every song made with the same instruments sounds alike.

## What Changes

- **Per-track sound settings, saved in the song.** Each Studio track gets an optional `sound` with:
  - **tone knobs** for the instrument itself;
  - **insert effects** in a fixed order: EQ, Distortion, Chorus, Delay, Reverb.

  Two tracks using the same instrument can sound different. A track without `sound` plays exactly as it does today.
- **Tone knobs.**
  - Every instrument gets a filter cutoff and a filter resonance.
  - Melodic instruments also get an amp envelope: attack, decay, sustain, release.
  - Drums also get a pitch knob, in semitones.
  - Each knob's default is the instrument's current preset value.
- **Effects.**
  - **3-band EQ:** low, mid, high.
  - **Distortion:** drive, mix.
  - **Chorus:** rate, depth, mix.
  - **Delay:** time synced to the song tempo, feedback, mix.
  - **Reverb:** decay, mix.

  Each effect has an on/off switch. Effects are off for new tracks.
- **Sound panel.** A Sound control on each track header opens a panel of knobs for that track. The existing pan knob becomes a reusable knob component, with drag, fine drag, keyboard steps, double-click to reset, and a value readout.
- **Live and undoable.** Changes are heard within 50 ms during playback and in note previews. Each knob drag or effect toggle is one undo step.
- **Validated everywhere.** The browser, project-file import, and backend song validation all check sound values against fixed ranges. MIDI export ignores sound settings.
- The single-instrument editor pages keep the default instrument sound. They get no panel.

## Capabilities

### New Capabilities
- `songs/track-sound`: the per-track `sound` document, the tone knobs and effects with their ranges and defaults, the Sound panel and knob interaction, real-time application in playback and previews, undo, validation, and how sound is handled by export, chat, and track creation.

### Modified Capabilities
<!-- None: the new field is additive. The existing song-document, mixer, and export requirements stay true as written, and track-sound states how it interacts with them. -->

## Impact

- **Frontend audio:**
  - `lib/audio/engine.ts`: `makeEntry`, `applyMixer`, and `previewVoice`.
  - `lib/audio/synthSource.ts` and `drumsSource.ts`: tone parameters.
  - `lib/audio/presets.ts`: preset effects become knob defaults where they overlap.
  - `lib/audio/types.ts`: `Voice` carries sound.
  - `songPlaybackModel.ts`.
- **Frontend song:** `lib/song/songOps.ts` (a sound op with no-op detection), `songStore` gestures, `projectFile.ts` (range checks), and `migrate.ts` (keeps the field).
- **Frontend UI:** new `Knob` (generalised from `PanKnob.tsx`), `TrackSoundPanel`, and a Sound button in `TrackHeader.tsx`.
- **Backend:** `music::song::Track` gains `#[serde(default)] sound: Option<TrackSound>`, with validation ranges and new invalid-case fixtures. The schema snapshot and TS bindings are regenerated with `just gen-types`. The chat and context `Track` literals set `sound: None`.
- No new dependencies. Tone.js already provides every effect node needed.
