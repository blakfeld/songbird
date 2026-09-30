# Proposal

## Why

A songwriter sketching a song needs more than drums and piano. At minimum they need a bassline, a pad or strings bed, and a lead or keys part. The melodic foundation (`add-melodic-instrument-model`) and the pitch-row editor with synth playback (`add-melodic-piano-roll`) make each extra instrument mostly data. Shipping a practical set now gives multitrack songs (`add-multitrack-song`) a real palette.

## What Changes

- **Seven new synthesized melodic instruments**, each with its own range, General MIDI program, generation prompt, mock examples, and synth voice:
  - Electric Piano
  - Organ
  - Bass
  - Synth Lead
  - Synth Pad
  - Strings
  - Pluck
- **Monophonic generation for Bass and Synth Lead.** When the AI stacks notes at one step on these instruments, generation keeps a single line: the lowest note for Bass, the highest for Synth Lead. Hand editing stays unrestricted.
- **Instrument discovery** lists nine instruments in a fixed order: drums, piano, and the seven above.
- **Each instrument gets its own editor page** automatically (`/instruments/<id>`), and it appears on the landing page.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `instruments/melodic`:
  - "Melodic catalog" gains the seven instruments.
  - New requirements "Monophonic generation" and "Distinct synth voices".

  This is written against the text after `add-melodic-instrument-model` and `add-melodic-piano-roll` are archived.
- `patterns/generation`: "Instrument discovery" lists the nine instruments. It is written against the text after `add-melodic-instrument-model`.

## Impact

- **Backend:**
  - Seven new modules under `backend/crates/music/src/instruments/`, each with id, name, program, range, prompt, four example drafts, and the shared melodic fallback, registered in `instruments/mod.rs`.
  - An `Instrument::monophony` setting (`None`, `KeepLowest`, `KeepHighest`) applied during expansion.
  - Schema snapshots for each instrument.
- **Frontend:**
  - Seven synth presets in `frontend/src/lib/audio/presets.ts`.
  - No new pages or components, because routes and the landing page are data-driven.
- **Depends on:** `add-melodic-instrument-model` (#1) and `add-melodic-piano-roll` (#2). Archive after both.
