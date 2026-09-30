# Design

## Context

After `add-melodic-instrument-model`, a melodic instrument is a module in `backend/crates/music/src/instruments/` with these parts:
- id, name, and program;
- a `PitchRange`, from which rows are computed;
- a system prompt and four example drafts;
- the shared `melodic_phrase_end` fallback.

After `add-melodic-piano-roll`, the frontend needs only a synth preset in `frontend/src/lib/audio/presets.ts`. Routes, the landing page, the gutter, and the default note length are all data-driven. Without a preset, a melodic instrument falls back to a neutral voice. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- Adding each instrument stays as small as the architecture promised: one backend module plus one preset.
- Generated bass and lead lines are playable single lines, because models often stack notes.

**Non-Goals:**
- Letting users choose or tweak synth sounds or presets, or change the MIDI program.
- Enforcing monophony in the editor or during playback.
- Instrument-specific editing aids, such as bass-string ranges or organ drawbars.

## Decisions

### D1. One module per instrument, sharing a melodic constructor
The seven modules `electric_piano.rs`, `organ.rs`, `bass.rs`, `synth_lead.rs`, `synth_pad.rs`, `strings.rs`, and `pluck.rs` differ only in data. `instruments/melodic.rs` provides a `const fn melodic(...)`, or a builder, that fills `kind`, `sustained`, `midi_channel: 1`, and `fallback_variation`. Each module then states only what is distinctive. The registry order matches the spec's discovery order.
- *Alternative considered:* one table-driven module holding all seven definitions. Prompts and example drafts are long, instrument-specific text, and one file per instrument matches `drums.rs` and `piano.rs` and keeps diffs reviewable.

Each prompt names the role, for example: "a bassline: root-driven, mostly one note at a time, locks with a kick", or "a pad: long held chords, few onsets". Each mock example set includes one keyword-matched default so offline tests are predictable.

### D2. Monophony applied after expansion
`Instrument` gains `monophony: Monophony { None, KeepLowest, KeepHighest }`, which defaults to `None`. Bass uses `KeepLowest`, and Synth Lead uses `KeepHighest`.

The rule runs in `expand.rs` after the arrangement is expanded and before `settle`:
1. Group notes by `step` across rows, and keep the lowest or highest `midi_note`.
2. Then clip each kept note to the next kept onset.

`settle` still runs afterwards to handle pattern end and same-row overlap. Running the rule after expansion, and not per section in `draft.rs`, means clipping also works across measure boundaries, where a held note in measure 1 would otherwise overlap measure 2's first note.
- *Alternative considered:* enforcing monophony through the prompt only. Models do not reliably follow it, and the spec needs a guarantee.

This is not exposed in `InstrumentInfo`. The rule is a generation guarantee, not an editor constraint, and exposing it would invite a UI contract the user did not ask for.

### D3. Synth presets
The frontend `presets.ts` entries use the Tone voice types that `createSynthSource` supports:

| id | Voice | Envelope sketch |
|---|---|---|
| `electric-piano` | FMSynth, harmonicity 3, a low modulation index | A 0.005 / D 1.2 / S 0.2 / R 0.8 |
| `organ` | Synth, fatsine, or AMSynth | A 0.01 / D 0 / S 1 / R 0.05 |
| `bass` | MonoSynth-like Synth (sawtooth plus lowpass) | A 0.005 / D 0.2 / S 0.6 / R 0.1 |
| `synth-lead` | Synth, square | A 0.01 / D 0.1 / S 0.8 / R 0.15 |
| `synth-pad` | Synth, fatsawtooth, and a chorus effect | A 0.6 / D 0.5 / S 0.8 / R 1.5 |
| `strings` | Synth, fatsawtooth, and a lowpass | A 0.15 / D 0.3 / S 0.9 / R 0.6 |
| `pluck` | Synth, triangle | A 0.002 / D 0.6 / S 0 / R 0.2 |

The values are starting points to tune by ear within this PR. The spec only fixes each voice's character: a steady organ, a pluck that decays to silence, and a pad that attacks slowly.

Tests assert the envelope *properties* the spec names, such as organ sustain = 1, pluck sustain = 0 with decay under 1 s, and pad attack greater than piano attack, and not exact values. That leaves tuning free.

## Risks / Trade-offs

- **[Risk] The bass range E1–G3 is low for laptop speakers.** → The bass preset adds harmonics through sawtooth plus a filter, so it is audible on small speakers.
- **[Risk] A long release on the pad makes loop boundaries muddy.** → This is acceptable. `stopAll` still silences everything immediately.
- **[Trade-off] Nine schema snapshots increase churn when the shared prompt changes.** → Snapshots are regenerated in one command, and they catch unintended drift.

## Migration Plan

This is additive. New stores are created lazily per instrument, and existing drums and piano work is untouched. Roll back by reverting.
