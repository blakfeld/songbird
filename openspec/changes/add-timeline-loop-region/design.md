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

### D1. Model: `LoopSetting = { start: number; end: number; enabled: boolean }`
- **Shape:** 1-based, inclusive measures, which is the same convention as today's `LoopRange`. That keeps `engine.setLoop` and its tests valid.
- **Pure helpers** in `lib/loopRegion.ts`:
  - `defaultLoop(measures)`;
  - `clampLoop(loop, prevMeasures, nextMeasures)`, which keeps a whole-length region whole and otherwise clamps;
  - `drawRegion(a, b)`;
  - `moveRegion(loop, delta, measures)`;
  - `resizeStart` and `resizeEnd`.
- **Who uses the helpers:** the ruler (pointer and keyboard), both stores (length changes), and loading (clamping stored values). Every bounds rule then lives in one place.
- **Alternative:** keep `LoopRange | null`, with null meaning off. That would lose the region while looping is off, but the spec keeps it visible and dimmed.

### D2. The engine gains `setLooping(enabled)` and a play-once ending
- **`nextMeasure` with looping off:** it returns `previous + 1`. On the first bar it returns `jumpTo ?? 1`.
- **Reaching the end:** when `previous === timing.measures` and looping is off, `tick` stops scheduling. It then arms a finish timer for the end of the last bar plus the longest scheduled note tail (tracked as `lastNoteEnd`). When that fires, it calls the existing `stop()` path, so `isPlaying`, the position, and subscribers reset exactly as they do for a user Stop.
- **Play with looping on:** `play()` clears a pending `jumpTo`, so Play starts at the region's start as the spec requires. A seek during playback keeps today's jump behavior.
- **Changes mid-play:** these fall out of deriving the next measure from the previous one, because `setLooping` and `setLoop` are read at each bar. No transport restart is needed.
- **Alternative:** stop at the end of the last bar and cut off the tails. The spec's "Last note rings out" rules this out.
- **Alternative:** a Tone.js `Transport.loop` flag. The engine schedules bar by bar with its own lookahead, so bolting Tone's loop onto it would create two sources of truth.

### D3. The `LoopRegion` overlay is layered on `MeasureRuler`
- `MeasureRuler` stays a static strip. A new `LoopRegion` component sits in the same `sticky` cell and uses the same `--cell-w`. It contains:
  - a hit layer covering the full ruler, for drawing;
  - the region body, as a `role="button"` with `aria-pressed`;
  - two edge handles, as `role="slider"` with `aria-valuemin`, `aria-valuemax`, and `aria-valuenow` in measures, about 8px wide.
- **Pointer handling:** it uses pointer capture. The measure is `floor((clientX − rulerLeft + scrollLeft) / cellWidthPx / stepsPerMeasure)`. A drag starts after 4px of movement, which is what separates a click from a drag.
  - **Click** on the body toggles. Click on the empty ruler does nothing.
  - **Drag** on empty ruler draws, on the body moves, and on a handle resizes.
- **Commit timing:** during a drag the region is previewed locally and committed once on release. The engine and the save then see a single change. Arrow-key edits commit immediately.
- **Styling:** the enabled region uses the existing loop colour, and the disabled state is at reduced opacity with a dashed outline, so colour is not the only signal.
- **`LoopShade`:** it renders only while the loop is enabled and not the whole length.
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
  - `setMeasures` and any pattern replacement, whether from generation or "start blank", run `clampLoop` with the previous and next lengths.
  - If the key has no `loop`, `defaultLoop(pattern.measures)` is used.
  - No Rust or `Pattern` change is needed.
- **Songs:** `Song` gains an optional `loop_region?: { start_measure; end_measure; enabled }`.
  - The snake_case keeps the fields mirrorable for #5, and there is no version bump, because `migrate.ts` passes the field through.
  - Loading clamps it, or defaults it when it is absent.
  - `songStore.setLoop` does a raw `set({ song: { ...song, loop_region } })`, with no `past` push, so autosave picks it up through `state.song !== last`.
  - `undo`, `redo`, `cancelGesture`, and gesture commits all apply one helper, `withLiveLoop(snapshot, current)`. It copies the current `loop_region` onto the restored snapshot, then runs `clampLoop` if the snapshot's `measures` differ. That way undo never moves the region (spec "Region changes are not undo steps").
  - `setSongLength` applies `clampLoop`.
  - Duplicating a song already uses `structuredClone`, so the region is copied.
- **Alternative:** store the song loop in localStorage keyed by song id. It would drift from the song on duplicate and delete, and the user asked for it to be saved with the song.
- **Alternative:** a separate pattern-loop key. It would need its own clearing rules, while the store sidecar gets them for free.

### D6. The pages become thin
- **`PatternEditorPage`** and **`StudioPage`** drop `loopState` and the length-reset logic. They read `loop` from their store, pass it to `Transport`, the ruler host, and `LoopShade`, and push `{start, end}` and `enabled` into the playback hooks.
- **The hooks:** `usePlayback(instrumentId, loop)` and `useSongPlayback(store, instruments, loop)` now take a `LoopSetting` and call `setLoop` and `setLooping`.

## Risks / Trade-offs

- **[Risk] Drawing on the Studio's fit-to-width ruler is fiddly on 128-measure songs, where each measure is a few pixels wide** → edge handles have a hit target at least 8px wide that extends beyond the visible edge, and the keyboard sliders give precise control. Zoom is a later concern.
- **[Risk] The play-once finish timer races with a user Stop or a new Play** → the timer is cleared in `stop()` and `play()`, and engine tests cover Stop before the timer fires and Play right after an automatic stop.
- **[Risk] Undo snapshots carrying stale `loop_region` values could leak into the saved state** → `withLiveLoop` is applied at every point where a snapshot is restored, and a store test asserts the region survives undo, redo, and a cancelled gesture.
- **[Trade-off] Clicking empty ruler space no longer does anything.** Seeking stays on the lanes to avoid a click that means two things. This can be revisited if users ask for seek on the ruler.
- **[Trade-off] "Loop" now names both clip content and playback in the Studio** → D4's qualified names and their placement mitigate it. A rename to "Cycle" is a small copy change later if it confuses people.

## Migration Plan

- There are no data migrations. Songs and patterns missing the field get `defaultLoop`, which matches today's behavior of looping the whole length.
- Rollback is a frontend revert. Old code ignores the extra `loop_region` field and the extra persisted `loop` key.
- Before `add-song-sections` and `add-context-aware-track-generation` are built, update them with `/opsx:update`: selecting a section sets the region and turns looping on, and the generation "Loop range" option requires looping on with a region that is not the whole length.
