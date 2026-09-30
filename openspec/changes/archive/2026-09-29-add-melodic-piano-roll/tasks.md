# Tasks

## 1. Routing and landing page

- [x] 1.1 Add `frontend/src/app/instruments/[id]/page.tsx` per design D1 (server redirect for `drums`, client lookup with loading, not-found panel, and `PatternEditorPage` for listed ids); verify Vitest tests for the piano render, the unknown-id not-found panel with a link to `/`, and that the drums id redirects
- [x] 1.2 Make `app/page.tsx` list every instrument from `getInstruments`, linking drums to `/drum-machine` and others to `/instruments/<id>`, with the Drum Machine link as the fallback on fetch error; verify Vitest tests for both the success and error cases

## 2. Pitch-row piano roll

- [x] 2.1 Add `isBlackKey(midiNote)` and `defaultNoteLength(sustained, ts)` helpers in `lib/pianoRoll.ts`; verify unit tests (C#4 is black, C4 is white; 4/4 and 3/4 give 4, 6/8 gives 6; drums give 1)
- [x] 2.2 Update `patternOps.toggleNote` to take a default length clipped to the next note and pattern end (D4), and pass it from `PianoRoll`; verify unit tests for the piano 4-step default, clipping to 2 before a note at step 2, clipping at pattern end, and the drums length 1 being unchanged
- [x] 2.3 Render the keyboard gutter in `RowLabels.tsx` for melodic instruments (D2: Logic-style keyboard with piano-proportioned white keys and row-aligned black keys, C-only visible labels, `aria-label` per row, `<button>` keys, single roving Tab stop) and black-row shading in `MeasureColumn.tsx`, with the melodic `--row-h` sizing; verify `PianoRoll.test.tsx` cases that 61 rows render, `C4` is labelled, `C#4` has black styling, every key's accessible name is its pitch, the key geometry is right (C4 is 5/3 of a row, A4 is 7/4 of a row, C#4 is one row on its own row), and the gutter is one Tab stop with arrow-key navigation
- [x] 2.4 Implement the initial vertical scroll on pattern load (D3); verify Vitest tests that, with a mocked element size, loading notes in C5–G5 sets `scrollTop` to show them and an empty pattern shows C4, while editing a note does not change `scrollTop`
- [x] 2.5 Confirm the drum roll is unchanged: all existing `PianoRoll.test.tsx` and `PatternEditorPage.test.tsx` drum cases pass with no snapshot or selector changes

## 3. Synthesized sound

- [x] 3.1 Move `velocityToGain` to `lib/audio/velocity.ts` and update the drums import; verify existing drums source tests pass
- [x] 3.2 Implement `lib/audio/synthSource.ts` (a self-managed pool of 32 voices, no reuse inside a release tail, stealing the voice with the earliest start strictly before the new note and otherwise dropping it, trigger with release at `endSeconds`, and `stopAll` fading out and disposing the pool) per D5; verify unit tests with a mocked Tone module for attack and release times and gain, stealing on the 33rd note, dropping a same-instant 33rd note, dropping a note that starts before all 32 queued voices, and `stopAll`
- [x] 3.3 Add `lib/audio/presets.ts` with the piano preset and a neutral fallback preset, and register them in `registry.ts` (fallback for any non-drums id without a preset); verify a registry test that `piano` and an unknown id both resolve to a synth factory, and that `drums` still resolves to the kit
- [x] 3.4 Add `engine.audition(row)` and wire the keyboard gutter to it (D6); verify a Vitest test that clicking the `A4` key calls `trigger` once with a 0.5 s duration and velocity 100, and leaves the store's pattern and history unchanged

## 4. End-to-end and docs

- [x] 4.1 Add `frontend/e2e/piano.spec.ts` (mock provider) that opens `/` and follows the Piano link, generates a pattern, sees notes in the roll, adds a one-beat note, plays and stops without console errors, downloads MIDI, and reloads to find the pattern restored; verify it passes in `just test`
- [x] 4.2 Update the root `README.md` (tools list and how to open the Piano) and verify the described steps work against `just dev` with the mock provider

## 5. Integration checks

- [x] 5.1 Run `just lint` and `just test`; verify both pass
- [ ] 5.2 Manually check a 32-measure piano pattern in Chrome and Safari for horizontal and vertical scrolling smoothness and audible playback with the network disabled; record the result in the PR description, opening a follow-up for canvas rendering if scrolling is not smooth
- [x] 5.3 Run `openspec validate add-melodic-piano-roll --strict` and verify it reports the change as valid
