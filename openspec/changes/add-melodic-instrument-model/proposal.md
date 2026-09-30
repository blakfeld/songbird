# Proposal

## Why

Drums is Songbird's only instrument. Songwriters need pitched parts too (keys, bass, pads, leads) before multitrack songs and chord tools make sense. The drum-machine design left pitch ranges, programs, and melodic generation "to the change that adds that instrument". This change is that foundation, and it ships the first melodic instrument, **Piano**, end to end on the API.

## What Changes

- **New melodic instrument kind.** A melodic instrument's rows are every chromatic pitch in its range, listed high to low and named in scientific pitch notation (`C4` = MIDI 60, sharps for accidentals). Its notes sustain for their length.
- **Piano instrument** (`piano`): range C2–C7 (61 rows), MIDI channel 1, General MIDI program 1 (Acoustic Grand Piano).
- **Instrument discovery** (`GET /api/v1/instruments`) now lists `drums` and `piano`. Each entry gains `kind` (`"drums"` or `"melodic"`), `midi_program` (1–128, or `null` for drums), and `range` (`{low, high}` MIDI notes, or `null` for drums).
- **Pattern document** gains an optional `midi_program` field that defaults from the instrument, so drum patterns already saved in browsers still load and export unchanged. `version` stays 1.
- **Melodic generation.** `POST /api/v1/patterns/generate` accepts `instrument: "piano"`. The model writes one lane per pitch in the existing compact draft format, so chords are simply several lanes playing at once. Pitches may be written with flats or as MIDI numbers. Out-of-range pitches are moved by whole octaves into range, or dropped if they cannot fit. Long patterns that repeat verbatim get a deterministic melodic phrase-end variation.
- **MIDI export** writes a Program Change for melodic patterns so a DAW picks a matching General MIDI sound. Drum exports are unchanged.
- The mock provider gains built-in piano example drafts, so tests and CI stay offline.
- Not in this change (see follow-ups): a piano-roll page and in-browser synth sound for melodic instruments (`add-melodic-piano-roll`), and further instruments (`add-synth-instrument-set`).

## Capabilities

### New Capabilities
- `instruments/melodic`: Rules shared by pitched instruments: pitch rows over a range, sustained notes, General MIDI program, melodic generation behavior (pitch lanes, octave folding, phrase-end variation), and the melodic instrument catalog (Piano in this change).

### Modified Capabilities
- `patterns/generation`: "Instrument discovery" lists `piano` and adds `kind`, `midi_program`, `range`. "Pattern document format" adds `midi_program` and allows pitch rows.
- `patterns/midi-export`: "MIDI file contents" adds a Program Change for patterns with a `midi_program`. "DAW compatibility" adds melodic import behavior.

## Impact

- **Backend (`music` crate):**
  - `instruments/mod.rs`: `Instrument` gets `kind`, `midi_program`, and computed pitch rows. `InstrumentInfo` gets the new fields.
  - New `instruments/piano.rs` and a shared pitch-name helper.
  - `draft.rs` resolves lanes for melodic instruments.
  - `expand.rs` adds a melodic fallback variation.
  - `pattern.rs` adds `midi_program`, and `midi.rs` writes the Program Change.
  - `ai/prompt.rs` adds melodic prompt text and the schema lane list.
  - `ai/mock.rs` gains piano examples.
- **API (`api` crate):** no new routes. The registry-driven handlers pick up `piano` automatically.
- **Shared types:** `InstrumentInfo`, `Pattern`, and a new `InstrumentKind` / `PitchRange` are regenerated with `just gen-types`.
  - Frontend code that builds `Pattern` literals (mainly tests) must add `midi_program`.
  - The frontend UI does not otherwise change. `/drum-machine` keeps asking for `drums`.
- **Compatibility:** additive. Existing clients that ignore unknown fields keep working. A saved pattern without `midi_program` is accepted.
- **Depends on:** nothing. This is change 1 of the melodic → multitrack → songwriting roadmap. Archive it before `add-melodic-piano-roll` and `add-synth-instrument-set`, which modify the same requirements.
