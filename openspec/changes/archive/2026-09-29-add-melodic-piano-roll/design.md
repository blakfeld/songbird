# Design

## Context

The frontend already treats the editor generically:
- `PatternEditorPage` (`frontend/src/components/editor/PatternEditorPage.tsx`) takes an `instrumentId` and looks up the instrument through `getInstruments`.
- `PianoRoll.tsx` renders `pattern.rows` as a DOM grid with sticky `RowLabels`. The scroller is `max-h-[70vh] overflow-auto` with `--row-h:32px`, so vertical scrolling already works mechanically.
- Stores are per instrument (`lib/patternStore.ts`, key `songbird.patterns.<instrument>.v1`).

Audio goes through `lib/audio/engine.ts`, which asks `lib/audio/registry.ts` for a `SoundSourceFactory` per instrument id. `SoundSource` is `load(rows)` / `trigger(row, start, end, velocity)` / `stopAll()`, and it already passes `endSeconds` for sustained instruments. The only source today is `drumsSource.ts` (Tone.Players over WAVs).

After `add-melodic-instrument-model`, `InstrumentInfo` carries `kind`, `range`, and `midi_program`, and piano rows are 61 pitch rows ordered high → low. See proposal.md for the motivation.

## Goals / Non-Goals

**Goals:**
- One editor for every instrument. The only branches on `kind` are the gutter rendering, the row height and shading, and the default note length.
- Adding a melodic instrument on the frontend means registering one synth preset.
- A 61-row × 32-measure roll stays responsive; it has 31k cells, so the current DOM grid needs no virtualization.

**Non-Goals:**
- Canvas rendering or row virtualization. This is revisited only if the manual 32-measure check fails.
- Scale highlighting or snap-to-key. That comes after song keys exist (`add-section-chord-generation`).
- Computer-keyboard or MIDI-keyboard note input.
- Multitrack, which is `add-multitrack-song`.

## Decisions

### D1. Dynamic route `/instruments/[id]` with client-side validation
`app/instruments/[id]/page.tsx` renders `PatternEditorPage instrumentId={id} title={instrument.name}`. Instruments come from the API at runtime, and the editor is a client page (see the drum-machine design, where the editor is not SSR'd), so the page checks the id against `getInstruments` on the client:
- while loading, it shows the existing loading state;
- when the id is not listed, it renders a not-found panel;
- when the instruments list fails to load, it shows an error with Retry, not the not-found panel, because the id may well be valid.

The client page (`components/editor/InstrumentPage.tsx`) passes the `InstrumentInfo` it already fetched into `PatternEditorPage`. Otherwise the editor's own `getInstruments` fetch leaves `kind` and `sustained` unknown while it loads, which would render the roll drum-styled until it arrives, and permanently if that second fetch fails. `/drum-machine` passes nothing, so it keeps fetching on its own.

`id === "drums"` is handled in the server component with `redirect("/drum-machine")`, so the canonical Drum Machine URL stays unique.
- *Alternative considered:* `generateStaticParams` from a hard-coded list. It would duplicate the backend registry.
- *Alternative considered:* fetching the list in a server component. The backend URL is only proxied for the browser today, and SSR fetching adds config surface.

The landing page becomes a small client component that lists instruments from `getInstruments`. It falls back to the Drum Machine link if the list fails to load, so the page never renders empty.

### D2. Keyboard gutter as a `RowLabels` variant
`RowLabels` gets a `kind` prop. For `melodic` it draws a vertical piano keyboard in the style of Logic Pro, computing black or white from `midi_note % 12 ∈ {1,3,6,8,10}`. The keys have real piano geometry rather than one key per row, so the gutter reads as a keyboard at a glance:
- **White keys** are full gutter width, light grey with thin dividers, and square-cornered. Each octave's white keys split its 12 rows the way a piano does: C, D and E share the 5 rows C–E (5/3 of a row each), and F, G, A and B share the 7 rows F–B (7/4 of a row each). The E|F and B|C boundaries therefore fall on grid-row edges. Keys at the range edges are clipped to the gutter.
- **Black keys** are exactly one row tall and aligned to their grid row. They sit flush left at about 58% of the gutter width, drawn above the white keys.
- **Labels** appear only on C keys (`C4`), right-aligned toward the bottom of the key, where no black key covers them.
- The keys stay light in dark mode, as Logic's do.

Every pitch is one absolutely positioned `<button>` with `aria-label` = row name and the drawn shape as its click target, and it is the audition target (D6). The gutter is a single Tab stop with a roving tabindex, starting on C4. Up, Down, Home and End move between keys, and Enter and Space audition. Without the roving tabindex, 61 tab stops would sit before the grid. The global Space play/stop shortcut ignores key targets so that Space auditions. `MeasureColumn` receives a per-row `isBlack` flag and paints a subtle background on black rows. Melodic rolls set `--row-h` to 18px (24px on coarse pointers) so about two octaves fit in `70vh`. The gutter's shapes change only its own drawing, and grid rows stay uniform.
- *Alternative considered:* a separate `KeyboardGutter` component. It would duplicate the sticky positioning and ref plumbing that `RowLabels` already handles for label-width measurement in `PianoRoll`.

### D3. Initial vertical scroll
`PianoRoll` scrolls vertically only when a new pattern is *loaded*: on mount, after generation, or after "New empty pattern". It keys this on a `loadId` counter in `lib/patternStore.ts`, which only `setPattern` and `newEmptyPattern` bump, not edits, undo or redo, so it never fights the user. The counter is not persisted. The target is the row range of the notes (the minimum and maximum row index), centered, and the `C4` row when there are no notes. When the range is taller than the viewport, the top of the range is shown, because melodies are read from their highest note. The code reuses the existing `labelWidth` / scroller refs and sets `scrollTop`. It is not smooth, so there is no motion on load.

### D4. Default note length in `patternOps`
`toggleNote(p, rowId, step, defaultLength = 1)` takes the length used when the click adds a note. Callers pass `instrument.sustained ? beatSteps(ts) : 1` and clip it to the next note's start in that row and to `totalSteps`. `beatSteps` (`lib/pianoRoll.ts`) already returns 4 or 6. This logic stays a pure function in `patternOps` so Vitest covers it without the DOM.

### D5. Synth sound source
The new `lib/audio/synthSource.ts` exports `createSynthSource(preset)`, which returns a `SoundSourceFactory`. It manages its own pool of up to 32 voices of the preset's class (`Tone.Synth` / `FMSynth` / `AMSynth`) and drives them with audio-time `triggerAttack` / `triggerRelease`:
- the preset supplies the voice class, options, and an optional effect chain (for example a gentle reverb for piano). The effect chain and a master gain live for the life of the source;
- `trigger` attacks at `start` with `velocityToGain(velocity)` and releases at `end`. `velocityToGain` moves from `drumsSource.ts` to a shared `lib/audio/velocity.ts`;
- `load` resolves immediately because no network is involved.

**Voice allocation.** Each voice records `startedAt` and `freeAt` (its end plus its envelope release). A voice is reused only once `freeAt <= start`, so no release tail is cut off. Below 32 voices, a new one is created. At 32, the voice with the earliest `startedAt` strictly before the new note's start is retriggered. Tone's attack and start cancel that voice's pending release and stop, so a stale release cannot cut the new note. If no voice started strictly earlier, the new note is dropped. That happens only when 33 or more notes start at the same instant, or when all 32 voices are queued ahead of it. A voice cannot be restarted at the instant it last started: Tone asserts against it, and an earlier retrigger would wipe out the voice's queued attack.

**Stop.** `stopAll` ramps the current pool's bus gain to 0 over 30 ms, disposes its voices after 200 ms, and starts a fresh pool for later triggers. Attacks and releases already queued in the engine's look-ahead window die with the old voices. `releaseAll` would miss them.

`lib/audio/presets.ts` maps instrument id → preset. The piano preset uses FM with a fast attack and an exponential decay to a low sustain. `registry.ts` registers `drums` and every preset id with `createSynthSource(preset)`. Any other id falls back to a neutral triangle-wave preset, so a backend-added instrument still makes sound. The fallback is not gated on `sustained`, because the registry only knows the instrument id. If a non-drum one-shot instrument is ever added, the registry will need the instrument info.
- *Alternative considered:* `Tone.PolySynth` (`maxPolyphony: 32`) with oldest-first release. PolySynth frees a voice only after its release tail has finished (`onsilence`), so releasing the oldest voice at the new note's start still drops the new note. It also holds future events in `setTimeout`s that `releaseAll` cannot cancel, so Stop would miss notes in the look-ahead window and stale releases would cut later notes short.
- *Alternative considered:* sampled piano (Salamander). The user explicitly wants synthesized instruments for now, samples add megabytes, and they break the "no network after load" guarantee until cached.

### D6. Audition
The gutter's `onAudition(row)` calls a new `engine.audition(row)`. The engine from `getPlaybackEngine(instrumentId)` is already per instrument, so it takes no id. It ensures the source is loaded, which is the same lazy Tone import as Play, and triggers a note 0.5 s long at velocity 100, starting at `now + 0.01`. Because it is a user gesture, it also unlocks the AudioContext, like Play does. It never touches the store. It shares the voice pool with playback, so when all 32 voices hold notes that start after the audition, the audition is dropped rather than silencing a queued note (D5).

## Risks / Trade-offs

- **[Risk] 61 rows × 512 steps of DOM cells feels slow on low-end devices.** → Rows are cheap `grid-template-rows` entries inside the existing per-measure `MeasureColumn` memoization. The manual check uses a 32-measure piano pattern in Chrome and Safari. If it fails, open a follow-up for canvas rendering, as the drum-machine design D4 anticipated.
- **[Risk] Synth CPU usage with dense chords at 32 voices.** → Each pooled voice is a single lightweight Tone synth. The FM piano uses two operators, and the voice cap bounds the cost.
- **[Trade-off] 18px rows are small touch targets.** → Coarse pointers get 24px rows. Velocity and resize still use the existing controls.

## Migration Plan

Frontend-only and additive. Saved drum patterns are untouched, and the piano store key is new. Roll back by reverting.
