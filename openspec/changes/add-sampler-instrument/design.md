# Design

## Context

- **Shared sample layer:** `add-audio-tracks` provides `Song.samples` and the reserved-id pattern (`TrackInstrument::{Instrument, Audio}`). It also provides the content-hashed `sampleStore` with an `AudioBuffer` cache, the `sampleLibrary`, the import pipeline, drag and drop with the `application/x-songbird-sample` MIME type, and reference-counted cleanup.
- **Sound sources:** `getSoundSourceFactory(instrument)` builds per-track sources (`lib/audio/registry.ts`). `synthSource` and `drumsSource` implement `SoundSource` with `setTone`, and the source feeds the track `InsertChain`.
- **Instrument data:** the piano roll, the row audition, live MIDI, and note recording all read rows from the instrument info (`InstrumentInfo.rows`). The backend validates note rows against the registry instrument.
- **Tone knobs:** from `add-track-sound-controls`, the melodic tone fields are filter and ADSR, and the drum fields are filter and pitch.

## Goals / Non-Goals

**Goals:**
- Sampler tracks reuse every note-based feature (piano roll, clips, loops, recording, MIDI input, undo) without special cases outside instrument lookup and sound production.
- One shared sample model, with no sampler-specific storage.

**Non-Goals:**
- Multi-zone and velocity-layer mapping, auto-slicing, choke groups, sustain loop points, and time-stretch.
- AI generation into sampler tracks. The model has no idea what a pad holds, and keys need sample-aware prompting. Both are left for a later change.

## Decisions

### D1. Two reserved instrument ids with built-in row sets
- `sampler-keys` and `sampler-pads` extend the `TrackInstrument` enum from `add-audio-tracks` with `Sampler(SamplerKind)`.
- Their `InstrumentInfo` objects are built in code rather than in the registry, so `GET /api/v1/instruments` and the instrument pages don't list them:
  - **Keys:** kind melodic, sustained, range 24–96, with standard pitch rows.
  - **Pads:** kind drums, not sustained, rows `pad-1` to `pad-16`.
- The frontend's instrument lookup (`useInstruments`) gains a `withBuiltIns()` helper that appends both, so `EditorDock`, `PianoRoll`, live play, and recording resolve them like any other id.
- Pad row display names come from the track's `sampler.pads`, through a `rowLabel(track, row)` override in the piano roll's row header. The ids themselves stay stable.
- *Why separate ids and not one sampler with a mode:* the row sets differ, so the mode would change the instrument identity, which the spec forbids after creation ("instrument SHALL NOT change").

### D2. `samplerSource` on pooled `Tone.Player`s
- A source holds a 32-voice pool of `Tone.Player`s feeding a per-voice `Gain`, which carries velocity and an envelope implemented with `Gain` ramps, then the source output.
- **Keys:** sustained notes use the envelope's ADSR on the voice gain and stop the player after the release. One-shot notes play to the buffer end with only the attack applied. Pitch comes from `playbackRate`, the `2^((n−root)/12)` ratio.
- **Pads:** every note is a one-shot at `pad.gain_db + velocity`, with `playbackRate = 2^((pad.pitch + track pitch)/12)`.
- `setTone` handles the filter (an existing `Tone.Filter` after the pool) and the envelope or pitch defaults.
- **Buffers:** a voice uses the `sampleStore` `AudioBuffer` cache. A missing buffer means a silent note plus a `missing` flag surfaced to the strip.
- **Stealing:** the oldest voice is stolen when the pool is exhausted, matching `synthSource`.
- *Alternative:* `Tone.Sampler`. It was rejected because it maps multiple samples to notes with its own pitch interpolation and envelope, but has no per-pad gain or pitch, no one-shot mode, and doesn't share the store's buffers cleanly.

### D3. Track `sampler` document and validation
- The Rust type is `SamplerSettings { keys: Option<KeysSettings>, pads: Vec<PadSettings> }`, with `#[serde(default)]`.
- Validation checks:
  - the right half is present for the instrument;
  - sample ids are in `song.samples`;
  - ranges are respected;
  - pad rows are unique and valid;
  - `sound.tone` is checked against the matching kind.
- Shared fixtures cover each rule.
- `sampleStore` cleanup (`collectGarbage` from `add-audio-tracks`) is extended to count every sample id referenced from `sampler`, in saved songs and in the open song's history.

### D4. Export and AI
- **`song_midi.rs`:** `TrackInstrument::Sampler` tracks go through the melodic channel allocator (skipping 10), with no Program Change. Note numbers come from the row's `midi_note`: pitch for keys, and 36 + index for pads.
- **Context:** `context.rs` treats keys as a melodic part labeled `"<name> (sampler)"` and skips pads.
- **Generation and chat:** generation rejects any sampler target with `invalid_target`. The chat planner never sees the reserved ids, as with `audio`.

### D5. Sampler strip UI
- `SamplerStrip` sits in `EditorDock` above the `PianoRoll` for sampler tracks:
  - **Keys:** a sample picker opening a library popover, Preview, Clear, a root-note select, and a One-shot switch.
  - **Pads:** no strip row. Pad assignment lives on the piano roll's row labels, each a drop target with a context menu, so assignment happens where the notes are.
- Gain and pitch use the `Knob` from `add-track-sound-controls`, inside the pad menu, with gesture-based undo.
- `ui-designer` defines the label drop affordance and the empty-pad look.

## Risks / Trade-offs

- [Pitching by playback rate changes duration and formants] → This is the expected classic sampler sound. Time-stretched pitching is out of scope.
- [Large samples pitched down use a lot of memory per voice] → The players share one `AudioBuffer`, so there is no copy per voice.
- [Row label overrides could confuse the existing row-id-based tests] → Labels are display-only, and ids are unchanged.
- [Dependencies] → It needs `add-audio-tracks` (task 1.1 checks for it) and the `add-track-sound-controls` tone knobs.
