# Design

## Context

See proposal.md for the motivation and the specs for the behavior.

**Where the loop state lives today.** The range is `useState` in `PatternEditorPage.tsx:48-60` and `studio/StudioPage.tsx:58-99`, as `loopState {start, end, measures}`.
- It falls back to the whole length whenever `measures` changes.
- It is pushed into the engine by `usePlayback`/`useSongPlayback` effects (`engine.setLoop`).
- It is never saved.

**The current controls.** `Transport.tsx:106-140` renders two `Select`s and a "Loop whole …" button.

**The rulers.**
- `MeasureRuler.tsx` is a non-interactive `sticky` strip of measure cells. It marks the loop with `data-in-loop`, `data-loop-start`, and `data-loop-end` attributes.
- `LoopShade.tsx` dims the grid outside the range, and is `pointer-events-none`.
- Single-instrument pages have one ruler, inside `PianoRoll.tsx:341`, at pattern scale with a fixed `--cell-w`, scrolling horizontally.
- The Studio has an arrangement ruler (`Arrangement.tsx:105-116`), fitted to the width at song scale. The dock has a second `PianoRoll` ruler that counts measures within the loop (`EditorDock.tsx:134`).

**The engine** (`lib/audio/engine.ts`).
- It always loops. `nextMeasure` (`:157-165`) wraps within `loop` (null means the whole length).
- `seek()` sets a one-shot `jumpTo`, which is consumed by the next bar or by the next Play.
- There is no path that ends on its own.

**Storage.**
- Patterns use zustand `persist` under `songbird.patterns.<instrument>.v1`, with `partialize: {pattern, prompt}`, no versioning, and shallow merge. `Pattern` is generated from Rust.
- Songs are `version: 2`. `migrate.ts` passes unknown top-level fields through. Undo in `songStore.ts` swaps whole `Song` snapshots.

**Terminology.** In the Studio UI, "loop" already names a clip's reusable content ("Place loop", "Loop length", the dock's "Loop <name>" chip).

## Goals / Non-Goals

**Goals:**
- One interactive ruler component and one region model, shared by both pages. The only difference between pages is their scale.
- Loop state is saved with the work but stays out of undo history, with no Rust type changes.
- An engine change that keeps today's looping timing exactly the same.

**Non-Goals:**
- Sub-measure regions. Changing the fit-to-width vs. scrolling ruler layouts. Ruler zoom.

## Decisions

### D1. Model: `LoopSetting = { region: LoopRange | null; enabled: boolean }`
- **Shape:** `LoopRange` is today's `{ start, end }` in 1-based, inclusive measures. A null `region` means none has been drawn. That keeps `engine.setLoop` and its tests valid, because the engine already treats a null range as the whole length.
- **Default:** `defaultLoop()` is `{ region: null, enabled: false }`. It takes no length, because "no region" does not depend on one. The product decision is that new and old work plays once until the user asks for a loop, which is also what the ruler shows (nothing).
- **Looping with no region:** `{ region: null, enabled: true }` loops the whole length. It is reached only through the Loop toggle, and does not create a region, so the ruler stays empty and a later draw narrows the loop.
- **No clearing:** no helper or UI path returns a drawn region to null. Once drawn, a region is redrawn, moved, resized, or toggled. This keeps the ruler's gestures to four with no "delete" affordance; turning looping off already stops the region from affecting playback.
- **Pure helpers** in `lib/loopRegion.ts`:
  - `defaultLoop()`;
  - `clampLoop(loop, measures)`, which leaves a null region null and otherwise clamps the region inside `1..measures`, keeping at least 1 measure;
  - `drawRegion(a, b)`;
  - `moveRegion(region, delta, measures)`;
  - `resizeStart` and `resizeEnd`;
  - `playRange(loop)`, returning `region` (or null for the whole length) for the engine.
- **The whole-length growth rule is dropped.** Earlier drafts grew a whole-length region when the length grew, because the whole-length region stood for "loop everything". A null region now carries that meaning, so a drawn region is always something the user chose. `clampLoop` therefore only clamps, and a lengthened pattern keeps a drawn 1–8 region at 1–8. It also no longer needs the previous length.
- **Who uses the helpers:** the ruler (pointer and keyboard), both stores (length changes), and loading (clamping stored values). Every bounds rule then lives in one place.
- **Alternative:** keep a flat `{ start, end, enabled }` and default it to the whole length. That was the previous plan; it cannot express "no region", so the ruler would always show a strip the user never drew.
- **Alternative:** `LoopRange | null`, with null meaning off. That would lose the region while looping is off, but the spec keeps it visible and dimmed.

### D2. The engine gains `setLooping(enabled)` and a play-once ending
- **`nextMeasure` with looping off:** it returns `previous + 1`. On the first bar it returns `jumpTo ?? 1`.
- **Reaching the end:** when `previous === timing.measures` and looping is off, `tick` stops scheduling. It then arms a finish timer for the end of the last bar plus the longest scheduled note tail (tracked as `lastNoteEnd`). When that fires, it calls the existing `stop()` path, so `isPlaying`, the position, and subscribers reset exactly as they do for a user Stop.
- **Play with looping on:** `play()` clears a pending `jumpTo`, so Play starts at the region's start as the spec requires. A seek during playback keeps today's jump behavior.
- **What the engine is given:** `setLoop(playRange(loop))`, so the region's range, or null (the whole length) when there is no region, and `setLooping(loop.enabled)`. The engine does not need to know whether a region exists.
- **Changes mid-play:** these fall out of deriving the next measure from the previous one, because `setLooping` and `setLoop` are read at each bar. No transport restart is needed.
- **Alternative:** stop at the end of the last bar and cut off the tails. The spec's "Last note rings out" rules this out.
- **Alternative:** a Tone.js `Transport.loop` flag. The engine schedules bar by bar with its own lookahead, so bolting Tone's loop onto it would create two sources of truth.

### D3. The `LoopRegion` overlay is layered on `MeasureRuler`
- `MeasureRuler` stays a static strip. A new `LoopRegion` component sits in the same `sticky` cell and uses the same `--cell-w`. It contains:
  - a hit layer covering the full ruler, for drawing;
  - when a region exists, the region body, as a `role="button"` with `aria-pressed`;
  - when a region exists, two edge handles, as `role="slider"` with `aria-valuemin`, `aria-valuemax`, and `aria-valuenow` in measures, about 8px wide.
  - With no region only the hit layer and a "Set loop region" button render, so the whole ruler is "outside" and any drag draws.
  - **"Set loop region" button:** a native button, visually hidden until focused, that is the keyboard path to the first region (WCAG 2.1.1). Enter or Space commits `{ region: { start: 1, end: 1 }, enabled: true }` and moves focus to the new end slider, so the arrow keys then extend the region with the existing slider behavior. A one-measure region at measure 1 is the smallest valid region and needs no choice from the user; the slider does the rest. It sits inside the `data-loop-region` root, so the existing Space/Enter exemption keeps it from reaching the transport and editor shortcuts. It does not render once a region exists, because the body and sliders take over.
- **Pointer handling:** it uses pointer capture. The measure is `floor((clientX − rulerLeft + scrollLeft) / cellWidthPx / stepsPerMeasure)`. A drag starts after 4px of movement, which is what separates a click from a drag.
  - **Click** on the body toggles. Click on the empty ruler does nothing.
  - **Drag** on empty ruler draws, on the body moves, and on a handle resizes. There is no exception for a whole-length region: a drag on its body moves it (which, at full length, cannot go anywhere). The implementation's current "a drag on a whole-length region draws" special case existed only because every pattern used to start with a whole-length region the user never drew; with no default region it is removed.
  - **A region covering every measure** leaves no outside space to draw in, so the user shrinks it by an edge first. This is the cost of having no clear action, and it only arises once the user has drawn or resized to full length.
- **Commit timing:** during a drag the region is previewed locally and committed once on release. The engine and the save then see a single change. Arrow-key edits commit immediately.
- **Styling:** the enabled region uses the existing loop colour, and the disabled state is at reduced opacity with a dashed outline, so colour is not the only signal.
- **`LoopShade`:** it renders only while looping is on and a region exists that is not the whole length. With no region, looping on covers everything, so there is nothing to shade.
- **The `data-*` attributes:** the old ones on `MeasureRuler` are removed and replaced by attributes on `LoopRegion`, and the tests move with them.
- **Where it mounts:**
  - on `PianoRoll`, only when a `loop` prop with an `onLoopChange` handler is given, which happens on the single-instrument pages;
  - on `Arrangement`, for the Studio.
  - The dock's `PianoRoll` passes neither, so its ruler stays static (spec "Region is not in the dock").
- **Alternative:** make every `MeasureRuler` cell interactive. That forces per-cell handlers and makes it harder to capture a drag across cells.

### D4. The transport Loop toggle
- **What changes:** in `Transport.tsx`, the loop `Select`s and the "whole" button are replaced by a toggle button placed right after Play/Stop.
- **Button details:** `aria-pressed`, a repeat-arrows icon plus a visible "Loop" label, and the tooltip and accessible name "Loop playback".
- **Why "Loop playback":** the user asked for a "Loop" toggle. The qualified name, and "loop region" in the ruler's accessible names, keep it distinct from clip loops in the Studio (the naming collision noted in Context). The Studio already puts clip loops in the dock, away from the transport.
- **Props:** `loop: LoopSetting` and `onLoopChange(LoopSetting)`. `measures` is no longer needed for the loop.
- **Alternative:** call the playback feature "Cycle", as Logic does. That would be unambiguous, but it isn't the term the user asked for.

### D5. Persistence stays out of undo on both pages
- **Patterns:** the `PatternState` store gets `loop` and `setLoop`, and `loop` is added to `partialize` beside `pattern` and `prompt`, under the same key.
  - History snapshots `Pattern` only, so the loop is naturally excluded.
  - `setMeasures` and any pattern replacement, whether from generation or "start blank", run `clampLoop` with the new length, so a drawn region that no longer fits is pulled inside it.
  - If the key has no `loop`, or its `loop` is not a valid `LoopSetting` (for example the flat `{start, end, enabled}` written by unreleased builds of this change), `defaultLoop()` is used.
  - No Rust or `Pattern` change is needed.
- **Songs:** `Song` gains an optional `loop_region?: { region: { start_measure; end_measure } | null; enabled: boolean } | null`.
  - It mirrors `LoopSetting` field for field, so converting between them is a rename. The enabled flag lives beside the region rather than inside it, because looping can be on with no region.
  - An absent or null `loop_region` means no region and looping off, which is `defaultLoop()`. A new song does not write the field until the user changes the setting.
  - The snake_case keeps the fields mirrorable for #5, and there is no version bump, because `migrate.ts` passes the field through.
  - Loading clamps it, and treats an absent, null, or malformed value (including the flat shape from unreleased builds) as `defaultLoop()`.
  - `songStore.setLoop` does a raw `set({ song: { ...song, loop_region } })`, with no `past` push, so autosave picks it up through `state.song !== last`.
  - `undo`, `redo`, and `cancelGesture` all apply one helper, `withLiveLoop(snapshot, current)`. It copies the current `loop_region` onto the restored snapshot, then runs `clampLoop` if the snapshot's `measures` differ. That way undo never moves the region (spec "Region changes are not undo steps"). A gesture commit does not need it: the committed song already carries the live region, and the gesture base it pushes onto `past` is corrected by `withLiveLoop` when it is later restored.
  - `setSongLength` applies `clampLoop`.
  - Duplicating a song already uses `structuredClone`, so the region is copied.
- **Alternative:** store the song loop in localStorage keyed by song id. It would drift from the song on duplicate and delete, and the user asked for it to be saved with the song.
- **Alternative:** a separate pattern-loop key. It would need its own clearing rules, while the store sidecar gets them for free.

### D6. The pages become thin
- **`PatternEditorPage`** and **`StudioPage`** drop `loopState` and the length-reset logic. They read `loop` from their store, pass it to `Transport`, the ruler host, and `LoopShade`, and pass the `LoopSetting` into the playback hooks.
- **The hooks:** `usePlayback(instrumentId, loop)` and `useSongPlayback(store, instruments, loop)` now take a `LoopSetting` and call `setLoop(playRange(loop))` and `setLooping(loop.enabled)`.

## Risks / Trade-offs

- **[Risk] Drawing on the Studio's fit-to-width ruler is fiddly on 128-measure songs, where each measure is a few pixels wide** → edge handles have a hit target at least 8px wide that extends beyond the visible edge, and the keyboard sliders give precise control. Zoom is a later concern.
- **[Risk] The play-once finish timer races with a user Stop or a new Play** → the timer is cleared in `stop()` and `play()`, and engine tests cover Stop before the timer fires and Play right after an automatic stop.
- **[Risk] Undo snapshots carrying stale `loop_region` values could leak into the saved state** → `withLiveLoop` is applied at every point where a snapshot is restored, and a store test asserts the region survives undo, redo, and a cancelled gesture.
- **[Trade-off] A region cannot be deleted.** Keeping the gesture set small means no "clear" action; the user turns looping off instead, and a full-length region must be shrunk by an edge before drawing elsewhere.
- **[Trade-off] Clicking empty ruler space no longer does anything.** Seeking stays on the lanes to avoid a click that means two things. This can be revisited if users ask for seek on the ruler.
- **[Trade-off] "Loop" now names both clip content and playback in the Studio** → D4's qualified names and their placement mitigate it. A rename to "Cycle" is a small copy change later if it confuses people.

## Migration Plan

- There are no data migrations. Songs and patterns missing the field get `defaultLoop()`: no region and looping off, so existing work now plays once until the user turns looping on or draws a region. This is a deliberate change from today's always-loop behavior.
- Rollback is a frontend revert. Old code ignores the extra `loop_region` field and the extra persisted `loop` key.
- Before `add-song-sections` and `add-context-aware-track-generation` are built, update them with `/opsx:update`: selecting a section sets the region and turns looping on, and the generation "Loop range" option requires looping on with a region that exists and is not the whole length.
