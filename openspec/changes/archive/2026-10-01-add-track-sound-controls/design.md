# Design

## Context

- **Playback:** this is Tone.js, loaded dynamically in `lib/audio/engine.ts`.
  - `makeEntry` (`engine.ts:324-335`) builds one `Tone.Channel` (volume and pan) per track and hands it to the instrument's `SoundSource` factory as its output.
  - `synthSource.ts:36-41` chains `voices → bus → master → ...preset.effects → output`. Presets (`presets.ts`) hardcode some effects: piano reverb, bass lowpass at 900 Hz, pad chorus, and strings lowpass at 3500 Hz.
  - Drums play `ToneBufferSource` one-shots into `output` (`drumsSource.ts`).
  - Note previews use a separate per-voice Channel (`previewVoice`, `engine.ts:357-374`), so whatever applies to playback must be applied there too.
  - `Voice` (`lib/audio/types.ts:41-52`) is built from the song in `songPlaybackModel.ts`. `applyMixer` diffs and ramps mixer changes over 20 ms.
- **Song document:** it is defined in Rust (`music::song::Track`), and the TS types are generated from it. Unknown fields are tolerated on both sides (`song.rs:25-28`, `migrate.ts`). Validation error kinds are shared between `song.rs` and `projectFile.ts` through fixtures.
- **Undo:** `songStore` already supports gestures (`beginGesture`, transient edits, `endGesture` = one step), and `PanKnob`/`VolumeSlider` use it.
- **Knob:** `PanKnob.tsx` already implements the knob interaction, but with pan-specific range, format, and angle.

## Goals / Non-Goals

**Goals:**
- An absent `sound` is bit-for-bit the current sound, so there is no migration or version bump.
- One audio graph per track, built once. Parameter changes ramp and don't rebuild nodes.
- The same chain is used for playback and previews.

**Non-Goals:**
- User-reorderable or duplicate effects, sends and return buses, a master-bus effect, and saved sound presets shared across songs.
- Effects on the single-instrument editor pages.
- Rendering effects into MIDI (no CC91/93), and audio export.
- Changing the instrument's oscillator type or synthesis model.

## Decisions

### D1. Fixed-slot schema, all fields optional
`TrackSound { tone: Option<Tone>, effects: Option<Effects> }`, where every leaf is an `Option`. It is serialized with `skip_serializing_if = "Option::is_none"` and `#[ts(optional)]`, like `Song.key`.
- *Why fixed slots rather than a list of `{type, params}`:* fixed order removes reorder UI, duplicate handling, and per-type tagged-union validation. It matches the five effects the user asked for.
- *Why optional leaves:* "default" means "the instrument preset", which differs per instrument and may change in code later. Storing only overrides keeps old songs and untouched knobs following the preset. "Reset" means deleting the field.
- *Alternative:* store resolved values. It was rejected because it freezes preset tweaks into every song and bloats documents.

Ranges live in one Rust table and one TS table, and the shared fixture file (`fixtures/song_validation.json`) gets cases for out-of-range values, a wrong instrument kind, and a bad delay `time`, so the two sides can't drift. Validation runs per track and reports `track N "name": <setting> ...`.

### D2. Per-track graph: source → ToneStage → InsertChain → Channel
The engine builds the chain in `makeEntry`, between the source and the Channel. The source receives the chain's input instead of the Channel.
- **ToneStage** is the instrument-owned part:
  - **Synths:** the envelope is applied by `set({envelope})` on the pooled voices. Filter cutoff and resonance drive a `Tone.Filter` (lowpass, −24 dB/oct) placed where the preset's filter was. Where a preset had no filter, one is added at the 20 kHz default, which is inaudible.
  - **Drums:** pitch maps to each `ToneBufferSource.playbackRate = 2^(semitones/12)`, applied at trigger time. The filter is a `Tone.Filter` after the hits.
  - The source factory signature gains an optional `ToneControls` handle so the engine can update parameters live.
- **InsertChain:**
  - `EQ3`, `Distortion`, `Chorus` (started), `FeedbackDelay`, then `Reverb`.
  - Each node is wrapped as `enabled ? node : bypass` using the Tone effect's `wet` param. A disabled effect is set to `wet = 0` with a 20 ms ramp rather than disconnected, so toggling never clicks or cuts tails.
  - EQ has no wet, so it is bypassed by setting all gains to 0 dB.
  - Effect `mix` maps to `wet` when enabled.
- **Lazy creation:** an effect node is only constructed the first time it is enabled. Until then the slot is a direct connection. Reverb in particular generates an impulse response asynchronously, and Chorus runs an LFO, so creating them lazily keeps CPU and memory flat for the common case of 16 tracks with no effects. Once created, a node stays for the life of the entry, so later toggles are ramps.
- **Delay time:** the note values are converted with `Tone.Time("8n.")` and similar, against the transport BPM. They are re-applied when tempo changes, through the same diff path as mixer values.
- **Reverb decay:** a change regenerates the impulse response, which is asynchronous. The old reverb keeps playing until the new IR is ready, then the engine crossfades. Decay drags are debounced to 150 ms so the IR isn't regenerated per pixel. This is the one parameter that may exceed 50 ms. That is acceptable because it is perceived as a tail-length change, but it is called out under Risks.

### D3. Previews share the track's chain
Rather than building a second chain for `previewVoice`, the preview Channel is connected into the track entry's InsertChain input (after ToneStage). Each preview voice gets its own ToneStage built from the same `Voice.sound`.
- *Why:* two reverbs per track would double CPU, and the two could drift. The preview Channel still exists, so mute and solo don't fade previews, which is the reason it was separate in the first place.
- *Trade-off:* a muted track's preview now goes through the track's effects but not its Channel. That is the intended behavior.
- *As built:* the preview source feeds the track's InsertChain input. The chain output is also tapped into the preview Channel through a gate. The gate opens only while the track is inaudible (muted or soloed out) and a preview is sounding: the preview's duration, a live key being held, plus a 3 s allowance for release and effect tails. It ramps closed over 20 ms afterwards. This keeps previews and live input audible with the track's effects, while the track's scheduled notes still fade with the muted Channel within 20 ms. Sending the preview Channel into the chain would apply volume and pan twice, and the muted Channel's −100 dB would silence previews. *Known limit:* if a scheduled note is still sounding when the user mutes the track and previews it within the allowance, that note is audible through the open gate until it closes.

### D4. Presets become defaults
- `SynthPreset` gains `defaults: { filterCutoffHz?, envelope }`. The preset `effects` that overlap user effects are moved into defaults or into the base voice:
  - **Bass and strings:** their preset filters become the ToneStage filter defaults (900 Hz and 3500 Hz).
  - **Piano:** the reverb and the pad chorus stay as fixed "character" effects inside the voice, before ToneStage. This preserves today's sound when the user's Reverb or Chorus is off.
- A `presets.test.ts` case asserts that an empty `sound` builds a graph equivalent to the old one: same node types and parameters.

### D5. One `setSound` op, gesture-aware
- `songOps.setSound(song, trackId, patch, {transient})` deep-merges a `SoundPatch`, where `null` deletes a field (reset). It returns the same song object when nothing changes, so a drag back to the start adds no history.
- `resetSound` deletes `track.sound`.
- The Studio wires these through the existing `beginGesture`/`endGesture` exactly as `setMixer` does.
- `Voice` gains `sound` (resolved against instrument defaults in `songPlaybackModel`), and `applyMixer` grows a `applySound(prev, next)` diff.

### D6. Generic `Knob` component
- `PanKnob` is generalised into `Knob` with these props: `min`, `max`, `step`, `defaultValue`, `scale: "linear" | "log"`, `format`, `label`, `onChange(value, {transient})`, and the gesture callbacks.
- `PanKnob` becomes a thin wrapper, so its tests continue to pass unchanged.
- The log scale maps position as `min·(max/min)^t`.
- Keyboard steps are 1% of travel, and 10% with Page Up/Down.

### D7. Sound panel placement
The panel is a non-modal popover anchored to the track header's Sound button. It is wide enough for six knob groups in two rows on desktop, and it becomes a bottom sheet on narrow widths. It is non-modal so the arrangement and transport stay usable. `ui-designer` produces the layout, the knob size, and the on/off affordance before implementation. The open panel's track id is UI state, not song state.

## Risks / Trade-offs

- [CPU with many effects on] → Lazy node creation, and one chain per track rather than per voice. Reverb IR generation is asynchronous, so it doesn't block. The panel shows no warning, but a perf check task measures 16 tracks with all effects on.
- [Reverb decay changes aren't instant] → Debounce and crossfade (D2). The spec's 50 ms applies to the change starting. The existing tail fades naturally.
- [Preset sound drift from refactoring presets into defaults] → The D4 equivalence test, plus a manual listening check in tasks.
- [Distortion volume jumps] → Drive maps to a curve with output gain compensation (`0.5 + 0.5·(1−drive)`), so turning drive up doesn't blast the mix.
- [Schema growth across Rust and TS] → Generated bindings (`just gen-types`), schema snapshot tests, and shared fixtures keep the two sides aligned.
