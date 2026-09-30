# Proposal

## Why

`add-melodic-instrument-model` makes the API offer a Piano and generate pitched patterns, but there is no page to use it and no sound for it. Songwriters need a piano roll that reads like a keyboard across five octaves and plays back in the browser. That also needs to be in place before multitrack songs can mix melodic parts with drums.

## What Changes

- **Instrument pages.** `/instruments/<id>` opens the existing pattern editor for any instrument listed by `GET /api/v1/instruments`:
  - The Drum Machine stays at `/drum-machine`, and `/instruments/drums` redirects there.
  - An unknown id shows a not-found page.
  - The landing page lists every available instrument instead of linking only to the Drum Machine.
- **Pitch-row piano roll.** For melodic instruments the row gutter becomes a vertical piano keyboard:
  - White and black keys are drawn, and every C is labelled (`C4`).
  - Black-key rows are shaded in the grid.
  - Rows are compact, and the roll scrolls vertically while the key gutter and measure ruler stay in view.
  - On open it scrolls to the pattern's notes, or to middle C when empty.
  - Clicking a key auditions that pitch.
  - Drum rows render exactly as today.
- **Sustained-note editing default.** On a sustained instrument, clicking an empty cell adds a note one beat long instead of one step, clipped to the next note or the pattern end. Drums keep length 1.
- **Synthesized melodic sound.** A built-in Web Audio synth sound source plays sustained instruments. It is polyphonic, velocity-sensitive, and releases at each note's end, with a piano-like voice for `piano`. No samples or network are needed.
- Generation, undo/redo, looping, tempo, swing, MIDI download, and per-instrument browser persistence work unchanged on melodic pages.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `patterns/piano-roll-editor`:
  - "Piano-roll display" gains pitch-row keyboard rendering and vertical navigation.
  - "Editing notes" gains a one-beat default length for sustained instruments.
  - New "Instrument pages" and "Pitch audition" requirements.
- `instruments/melodic`: new requirement for the built-in synthesized sound of melodic instruments. This capability is created by `add-melodic-instrument-model`, so that change must be archived first.

## Impact

- **Frontend:**
  - New `app/instruments/[id]/page.tsx` and `components/editor/InstrumentPage.tsx`, and an updated `app/page.tsx` that lists instruments. `PatternEditorPage.tsx` accepts the already-fetched instrument.
  - `components/editor/RowLabels.tsx` becomes a keyboard gutter for pitch rows, alongside `PianoRoll.tsx` and `MeasureColumn.tsx` (black-key shading, row height, initial vertical scroll). `useEditorShortcuts.ts` leaves Space on a key to audition.
  - `lib/patternOps.ts` changes the default note length, and `lib/patternStore.ts` tracks pattern loads for the initial scroll.
  - New `lib/audio/synthSource.ts` plus per-instrument synth presets, registered in `lib/audio/registry.ts`. `velocityToGain` moves to a shared `lib/audio/velocity.ts`, and `lib/audio/engine.ts` gains `audition`.
  - New Vitest tests and a new Playwright spec `e2e/piano.spec.ts`.
- **Backend:** none.
- **Dependencies:** none new. Tone.js already ships the synths.
- **Depends on:** `add-melodic-instrument-model` (#1). This change is required by `add-synth-instrument-set` (#3) and `add-multitrack-song` (#4).
