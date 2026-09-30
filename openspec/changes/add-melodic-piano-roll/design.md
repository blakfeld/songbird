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
- when the id is not listed, it renders a not-found panel.

`id === "drums"` is handled in the server component with `redirect("/drum-machine")`, so the canonical Drum Machine URL stays unique.
- *Alternative considered:* `generateStaticParams` from a hard-coded list. It would duplicate the backend registry.
- *Alternative considered:* fetching the list in a server component. The backend URL is only proxied for the browser today, and SSR fetching adds config surface.

The landing page becomes a small client component that lists instruments from `getInstruments`. It falls back to the Drum Machine link if the list fails to load, so the page never renders empty.

### D2. Keyboard gutter as a `RowLabels` variant
`RowLabels` gets a `kind` prop. For `melodic` it renders each row as a key, computing black or white from `midi_note % 12 ∈ {1,3,6,8,10}`:
- a black key is a narrower dark bar;
- only rows with `midi_note % 12 === 0` show text.

Every key is a `<button>` with `aria-label` = row name, which is the audition target (D5). `MeasureColumn` receives a per-row `isBlack` flag and paints a subtle background on black rows. Melodic rolls set `--row-h` to 18px (24px on coarse pointers) so about two octaves fit in `70vh`.
- *Alternative considered:* a separate `KeyboardGutter` component. It would duplicate the sticky positioning and ref plumbing that `RowLabels` already handles for label-width measurement in `PianoRoll`.

### D3. Initial vertical scroll
`PianoRoll` scrolls vertically only when a new pattern is *loaded*: on mount, after generation, or after "New empty pattern". It keys this on the pattern identity from the store's load actions, not on every edit, so it never fights the user. The target is the row range of the notes (the minimum and maximum row index), centered, and the `C4` row when there are no notes. The code reuses the existing `labelWidth` / scroller refs and sets `scrollTop`. It is not smooth, so there is no motion on load.

### D4. Default note length in `patternOps`
`addNote` takes `defaultLength`. Callers pass `instrument.sustained ? beatSteps(ts) : 1` and clip it to the next note's start in that row and to `totalSteps`. `beatSteps` (`lib/pianoRoll.ts`) already returns 4 or 6. This logic stays a pure function in `patternOps` so Vitest covers it without the DOM.

### D5. Synth sound source
The new `lib/audio/synthSource.ts` exports `createSynthSource(preset)`, which returns a `SoundSourceFactory`. It is built on a `Tone.PolySynth` (`maxPolyphony: 32`):
- the preset supplies the voice class (`Tone.Synth` / `FMSynth` / `AMSynth`), options, and an optional effect chain (for example a gentle reverb for piano);
- `trigger` calls `triggerAttackRelease(freq(row.midi_note), end - start, start, velocityToGain(velocity))`, reusing `velocityToGain` from `drumsSource.ts`, moved to a shared `lib/audio/velocity.ts`;
- `load` only constructs the synth, and it resolves immediately because no network is involved;
- `stopAll` calls `releaseAll()`.

When polyphony is exceeded, PolySynth drops new voices by default. The source therefore tracks the active voices and releases the oldest first, which meets the spec's voice-stealing rule.

`lib/audio/presets.ts` maps instrument id → preset. The piano preset uses FM with a fast attack and an exponential decay to a low sustain. `registry.ts` registers every preset id with `createSynthSource(preset)`. Any `sustained` melodic instrument without a preset falls back to a neutral triangle-wave preset, so a backend-added instrument still makes sound.
- *Alternative considered:* sampled piano (Salamander). The user explicitly wants synthesized instruments for now, samples add megabytes, and they break the "no network after load" guarantee until cached.

### D6. Audition
The gutter's `onAudition(row)` calls a new `engine.audition(instrumentId, row)`. It ensures the source is loaded, which is the same lazy Tone import as Play, and triggers a note 0.5 s long at velocity 100, starting at `now + 0.01`. Because it is a user gesture, it also unlocks the AudioContext, like Play does. It never touches the store.

## Risks / Trade-offs

- **[Risk] 61 rows × 512 steps of DOM cells feels slow on low-end devices.** → Rows are cheap `grid-template-rows` entries inside the existing per-measure `MeasureColumn` memoization. The manual check uses a 32-measure piano pattern in Chrome and Safari. If it fails, open a follow-up for canvas rendering, as the drum-machine design D4 anticipated.
- **[Risk] Synth CPU usage with dense chords at 32 voices.** → PolySynth voices are lightweight. The FM piano uses two operators, and the voice cap bounds the cost.
- **[Trade-off] 18px rows are small touch targets.** → Coarse pointers get 24px rows. Velocity and resize still use the existing controls.

## Migration Plan

Frontend-only and additive. Saved drum patterns are untouched, and the piano store key is new. Roll back by reverting.
