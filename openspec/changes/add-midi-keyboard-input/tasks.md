# Tasks

## 1. MIDI access layer

- [ ] 1.1 Implement `frontend/src/lib/midi/access.ts` per design D1:
  - the `MidiAccess` singleton, with `status`, `inputs`, `select`, and `subscribe`;
  - message parsing: note-on, note-off, velocity-0 note-on as note-off, CC64 as sustain, everything else dropped;
  - `songbird.midi.v1` persistence and restoring a remembered grant on load.
  - Add a reusable fake in `frontend/src/test/fakeMidi.ts`. Verify Vitest tests for "Grant access and see devices", "Unsupported browser" (status `unsupported`), denied access, "Hot-plug", the chosen input disconnecting and reconnecting, and parsing on all 16 channels.

## 2. Engine: held notes, time mapping, metronome

- [ ] 2.1 Add `noteOn` and `noteOff` to `SoundSource` in `synthSource.ts` and `drumsSource.ts`, where held voices have `freeAt = Infinity` and are stolen last (design D2). Add `engine.liveNoteOn` and `engine.liveNoteOff` through the preview channel routing. Verify with source tests (a held voice isn't reused until `noteOff`, drums fire a one-shot) and engine tests (a live note uses the track's volume and pan, and plays on a muted track).
- [ ] 2.2 Add `engine.stepAt(domTimeStamp)` per design D3, with output-latency compensation, swing-aware nearest step, loop-region wrap to the first step, and `null` past the end with looping off. Extend the Tone mock with `getOutputTimestamp`, `outputLatency`, and `baseLatency`. Verify engine tests for:
  - "Quantized to the nearest step" and "Early downbeat on a loop pass";
  - a swung odd step;
  - a note held across a loop wrap;
  - a note-on past the end with looping off, which is discarded.
- [ ] 2.3 Add the metronome click source and click scheduling on `beatSteps`, plus `play({countIn})` with a pre-roll bar and `subscribeCountIn` (design D6). Verify engine tests for "Metronome clicks on beats", "6/8 beats", "Count-in without the metronome", "Play has no count-in", Stop during the pre-roll, and that the first real bar starts right after the pre-roll.

## 3. Recording pipeline

- [ ] 3.1 Implement the pure `mergeRecorded` and quantize helpers in `lib/recording/take.ts`. Verify Vitest cases for "Same step replaces", shortening an earlier overlapping note, one-shot length 1, and a minimum length of 1.
- [ ] 3.2 Implement `InputRouter` in `lib/recording/router.ts` per design D4:
  - rows mapped by `midi_note`;
  - held-note and sustain state;
  - live note calls;
  - finished notes delivered to the active take.
  - Verify tests for "Key outside the instrument", "Sustain pedal holds notes", the velocity pass-through, and a mocked-clock check that the time from a message to `liveNoteOn` stays under 20 ms.
- [ ] 3.3 Add `previewTake` and `commitTake` to `patternStore`, and the pattern adapter (design D4). Verify store tests: "One take, one undo", "Overdub a drum beat" (notes from the first pass are present in the pattern during the second pass), the pattern length never changes, and an empty take leaves history unchanged.
- [ ] 3.4 Add the transient `recordNotes` and `newClipWithNotes` to `clipOps` with `takeState` (design D5), and the song adapter that uses the gesture. Verify `clipOps` and store tests for:
  - "Record into an existing linked clip", "Record over empty space", and "A take across a clip and empty space";
  - "Clip limit during a take", including the dropped count;
  - "Undo a take that created a clip";
  - a take that loops over empty space creates only one clip;
  - "Changing tracks mid-take", where the take stays on the original track.

## 4. Transport UI and shortcuts

- [ ] 4.1 Have `ui-designer` specify the Record, Count-in, Metronome, and MIDI input controls in the transport row:
  - the recording and count-in indicators;
  - the MIDI menu and its unsupported and denied states;
  - their fit on narrow viewports.
  - Verify the spec is recorded as `openspec/changes/add-midi-keyboard-input/ui-spec.md`.
- [ ] 4.2 Build the controls in `Transport.tsx` (design D7) with a shared `useMetronomeSettings` hook (`songbird.metronome.v1`), add `R` to `useShortcuts`, and announce the start and end of a take and dropped-note counts through the status region. Verify RTL tests for:
  - Record disabled until access is granted;
  - `R` ignored in text fields and dialogs;
  - the settings persisting across a remount;
  - "Record from stopped with count-in";
  - "Punch in and out";
  - "Stop during count-in".

## 5. Page wiring

- [ ] 5.1 Wire the router, adapters, and transport controls into `PatternEditorPage` on both `/drum-machine` and `/instruments/[id]`. Verify RTL tests driving the fake MIDI for "Play a melodic note" (the pattern is unchanged) and a recorded take appearing in the piano roll.
- [ ] 5.2 Wire the router and the song adapter into `StudioPage`, with the live target following `selectedTrackId` and the take target fixed when the take starts. Show recorded notes in the dock and lanes during the take. Verify RTL tests for "Studio plays the selected track" and a take visible in the lane overview no more than 100 ms after note-off.

## 6. Integration checks

- [ ] 6.1 Add a Playwright init script faking `requestMIDIAccess`, and e2e tests in `frontend/e2e/`:
  - on `/drum-machine`, grant access, record a looping take, reload, and check the notes persisted;
  - on `/studio`, record over empty lane space, check that a clip appears, undo, and check it is gone.
  - Verify that the Playwright run passes.
- [ ] 6.2 Run `just lint` and `just test`, and verify both pass.
- [ ] 6.3 Manually record with a real MIDI keyboard in Chrome at 90 and 140 BPM, with swing 0 and 0.5. Note in design Risks whether takes land on the intended steps, and whether a latency offset setting (the Open Question) is needed.
