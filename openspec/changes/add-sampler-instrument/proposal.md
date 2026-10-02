# Proposal

## Why

Imported samples (`add-audio-tracks`) can be placed as clips, but a lot of sample-based music plays samples from notes instead: a vocal chop or an 808 played across a keyboard, or a kit of one-shots tapped out on pads. Songbird already has the piano roll, live MIDI input, and note recording. A sampler instrument lets all of that drive the user's own sounds.

## What Changes

- **Two sampler track types in Add Track:**
  - **Sampler (keys):** one sample played across the keyboard. Each note plays it pitched relative to a root note (default C4), over pitch rows C1–C7. Notes either hold the sample for their length or play it through as a one-shot.
  - **Sampler (pads):** 16 pads, each assigned a library sample, with per-pad gain and pitch. Each note on a pad row plays that pad's sample as a one-shot, which suits drum kits built from one-shots.
- **Assigning sounds.** The editor dock shows a sampler strip above the piano roll:
  - **Keys:** choose the sample, the root note, and one-shot on or off.
  - **Pads:** each pad row label shows its sample name. Drop a library sample on a row label, or use its menu, to assign, clear, or adjust the pad.
  - The samples used are recorded in the song's `samples`, so bundles, storage, and cleanup handle them as they do clips.
- **Everything else works as for other instruments.** That covers piano-roll editing, auditioning rows, live MIDI play and note recording, loops and clips, and the track's tone knobs and effects:
  - keys use the melodic tone knobs (filter and amp envelope);
  - pads use the drum knobs (filter and pitch).
- **Export.**
  - **MIDI:** sampler tracks export their notes. Keys export their pitches on a melodic channel with no Program Change. Pads export notes 36–51 on a melodic channel.
  - **WAV mixdown:** sampler tracks are rendered as they play.
- **AI.**
  - The chat never creates sampler tracks, and generation isn't offered on them in this version.
  - Keys tracks are sent to generation as context, because their notes are pitches.
  - Pads tracks aren't sent, because pad numbers carry no musical meaning for the model.
- **Out of scope:** multi-sample mapping (zones and velocity layers), slicing a sample to pads automatically, choke groups, and loop points inside a sustained sample.

## Capabilities

### New Capabilities
- `instruments/sampler`: the keys and pads sampler instruments, their rows, the track's `sampler` settings, how notes play samples, sound assignment in the dock, and how sampler tracks behave in validation, export, and AI generation.

### Modified Capabilities
<!-- None: instrument-agnostic requirements (piano roll, clips, recording, mixer, effects) already apply to any instrument track. Sampler-specific export and AI rules are stated as new requirements in instruments/sampler, so that they don't collide with add-audio-tracks' changes to songs/export and songs/track-generation. -->

## Impact

- **Backend:** in `music::song`:
  - reserved ids `sampler-keys` and `sampler-pads` become `TrackInstrument::Sampler(Keys | Pads)`, with built-in row sets;
  - a `Track.sampler` type, with validation that samples are in `song.samples`;
  - `validate_sound` uses the melodic rules for keys and the drum rules for pads.
  - `song_midi.rs` handles sampler tracks, `context.rs` includes keys and excludes pads, and generation rejects sampler targets. Fixtures, the schema snapshot, and TS bindings are updated.
- **Frontend:**
  - `lib/audio/samplerSource.ts`, a `SoundSource` built from pooled `Tone.Player`s with `playbackRate` pitching and envelope or one-shot behavior.
  - Engine wiring through the existing source registry.
  - Sampler rows in the instrument lookup, so the piano roll and recording work unchanged.
  - The Add Track entries.
  - A `SamplerStrip` in `EditorDock`, with drop targets on pad row labels.
  - `sampleStore` garbage collection counts sampler references.
- **Depends on:** `add-audio-tracks` (sample store, library, and song `samples`) and `add-track-sound-controls` (tone knobs).
