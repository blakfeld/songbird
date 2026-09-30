# Tasks

## 1. Loop model and engine

- [x] 1.1 Add `frontend/src/lib/loopRegion.ts` with `LoopSetting`, `defaultLoop`, `clampLoop`, `drawRegion`, `moveRegion`, `resizeStart`, and `resizeEnd` (design D1). Verify with Vitest cases for the helper behind each spec scenario:
  - "Draw backwards", "Move stops at the end", and "Resize keeps one measure";
  - "Shortening clamps a partial region" (the whole-length growth case is superseded by section 6).
- [x] 1.2 In `lib/audio/engine.ts`, add `setLooping(enabled)` and the play-once ending (design D2):
  - `nextMeasure` counts on past the region when looping is off;
  - the end is detected when the previous measure is the last one;
  - a finish timer waits for the last bar plus note tails, then calls `stop()`;
  - `play()` clears `jumpTo` while looping is on.
  - Verify the existing `setLoop` and `seek` tests in `engine.test.ts` pass unchanged. Add tests for:
    - "Play once with looping off" and "Last note rings out";
    - "Turn looping off mid-play" and "Turn looping on outside the region";
    - Stop before the finish timer fires;
    - Play immediately after an automatic stop.
- [x] 1.3 Change `usePlayback` and `useSongPlayback` to take a `LoopSetting` and push `setLoop` and `setLooping`. Verify with `pnpm typecheck` and the existing playback hook tests.

## 2. Persistence

- [x] 2.1 Add `loop` and `setLoop` to the pattern store in `lib/patternStore.ts`, include `loop` in `partialize`, and use `defaultLoop` when it is missing. Apply `clampLoop` on `setMeasures` and whenever the pattern is replaced (design D5). Verify Vitest tests for:
  - "Reload restores the region" (persisted round trip);
  - a stored pattern with no `loop` loads with the default (superseded by 6.3: no region, looping off);
  - "Region changes are not undo steps".
- [x] 2.2 Add the optional `Song.loop_region` field and clamp or default it on load in `migrate.ts`. In `songStore.ts`, add `setLoop` with no history push, apply `withLiveLoop` in undo, redo, and gesture cancel, and apply `clampLoop` in `setSongLength` (design D5). Verify Vitest tests for:
  - undo, redo, and a cancelled gesture leave the region unchanged;
  - an undo that changes the length clamps the region;
  - autosave writes a region change;
  - duplicating a song copies the region;
  - a version 2 song without the field opens with the default (superseded by 6.3: no region, looping off).

## 3. Ruler and transport UI

- [x] 3.1 Have `ui-designer` specify the `LoopRegion` visuals:
  - the enabled and disabled region styles, and the edge handles with their hit areas;
  - the cursors for draw, move, and resize, and the focus rings;
  - the Loop toggle's icon, label, and pressed state beside Play;
  - how the region reads on the fit-to-width Studio ruler at 128 measures.
  - Verify the result is recorded as `openspec/changes/add-timeline-loop-region/ui-spec.md`.
- [x] 3.2 Build `components/editor/LoopRegion.tsx` over `MeasureRuler` (design D3):
  - pointer capture with a 4px drag threshold;
  - draw, move, and resize, with preview during the drag and a single commit on release;
  - click on the body toggles;
  - the edge sliders and a body toggle with keyboard support, and Space and Enter kept from reaching the transport.
  - Remove the loop `data-*` attributes from `MeasureRuler`, and show `LoopShade` only while looping is on and a region exists that is not the whole length.
  - Verify RTL tests for every scenario under "Editing the loop region on the ruler".
- [x] 3.3 In `Transport.tsx`, replace the loop `Select`s and the "Loop whole …" button with the Loop playback toggle (design D4). Rewrite the loop cases in `Transport.test.tsx`. Verify an RTL test for "Toggle beside Play", and that no "Loop start measure" or "Loop end measure" control remains.

## 4. Page wiring

- [x] 4.1 In `PatternEditorPage`:
  - drop `loopState` and read `loop` from the pattern store;
  - mount `LoopRegion` on the `PianoRoll` ruler through the `loop` and `onLoopChange` props;
  - pass the loop to `Transport` and `usePlayback`.
  - Verify with RTL tests: drawing a region on `/drum-machine` updates the transport toggle and the engine loop, and reload restores it.
- [x] 4.2 In `StudioPage` and `Arrangement`:
  - drop `loopState` and the per-open reset, and read `loop_region` from the song store;
  - mount `LoopRegion` on the arrangement ruler, and keep the dock's `PianoRoll` without it;
  - with looping on, stop lane seeking from overriding where Play starts.
  - Verify RTL tests for "Loop a range across tracks", "Song plays once", "Seek with looping off", and "Region is not in the dock". Rewrite the length-change assertion in `StudioPage.test.tsx` that used "Loop end measure".

## 5. Downstream planning and integration checks

- [x] 5.1 Run `/opsx:update` on `add-song-sections` and `add-context-aware-track-generation`:
  - selecting a section sets the loop region and turns looping on;
  - the "Loop range" generation option requires looping on and a region that exists and is not the whole length;
  - replace stale `Transport.tsx:16-17` citations.
  - Verify `openspec validate` passes for both changes.
- [x] 5.2 Add Playwright coverage in `frontend/e2e/studio.spec.ts` and `frontend/e2e/drum-machine.spec.ts`: drag a region on the ruler, toggle looping by clicking the region and with the transport button, reload and check that both persist, and turn looping off and check that playback stops by itself. Verify the Playwright run passes.
- [x] 5.3 Run `just lint` and `just test`, and verify both pass.

## 6. Default to no region

- [x] 6.1 In `lib/loopRegion.ts`, change `LoopSetting` to `{ region: LoopRange | null; enabled: boolean }` (design D1): `defaultLoop()` returns `{ region: null, enabled: false }`; `clampLoop(loop, measures)` leaves a null region null, clamps a drawn one, and drops the whole-length growth rule; `moveRegion`, `resizeStart`, and `resizeEnd` act on a `LoopRange`; add `playRange(loop)`. Update `loopRegion.test.ts`. Verify Vitest cases for "Lengthening keeps a drawn region", "No region follows the length", "Shortening clamps a partial region", and `clampLoop` leaving a null region null.
- [x] 6.2 Update `usePlayback` and `useSongPlayback` to push `setLoop(playRange(loop))` and `setLooping(loop.enabled)` (design D2, D6). Keep the engine's null-range-means-whole-length path. Verify `engine.test.ts` cases for "Loop the whole pattern" (looping on, null range) and "New pattern plays once", and `pnpm typecheck`.
- [x] 6.3 Pattern and song persistence (design D5):
  - `patternStore.ts`: default a missing or malformed persisted `loop` (including the flat `{start, end, enabled}` shape) to `defaultLoop()`, and call the new `clampLoop(loop, measures)`.
  - `types.ts`: change `Song.loop_region` to `{ region: { start_measure; end_measure } | null; enabled } | null`, optional.
  - `migrate.ts`: treat an absent, null, or malformed `loop_region` as `defaultLoop()`, and clamp a present region.
  - `songStore.ts` and `songOps.ts`: convert between `loop_region` and `LoopSetting`, and keep `withLiveLoop` and `setSongLength` working with a null region.
  - Verify Vitest tests: "Stored work without loop data" for patterns and songs, a new song has no region and looping off, a round trip of `{ region: null, enabled: true }`, and undo, redo, and gesture cancel with a null region.
- [x] 6.4 In `LoopRegion.tsx`, render only the hit layer and live region when `region` is null (6.8 adds the "Set loop region" button), so a drag anywhere on the ruler draws; remove the "a drag on a whole-length region draws" exception so a drag on any region body moves it; keep drawing turning looping on (design D3, ui-spec "No region"). Show `LoopShade` only when looping is on and a region exists that is not the whole length. Verify RTL tests for "Draw a region" (from no region), "Draw backwards", "Dragging a full-length region moves it", and that no `loop-region` element renders with no region.
- [x] 6.5 In `Transport.tsx`, `PatternEditorPage`, `StudioPage`, `Arrangement`, and `PianoRoll`, pass the new `LoopSetting` shape through; the Loop toggle flips `enabled` and leaves a null region null; Studio seeking uses measure 1 as the Play start with looping on and no region. Verify RTL tests for "New song has no region", "Loop the whole pattern" (toggle leaves the ruler empty), and updated "Toggle beside Play", `Transport.test.tsx`, and `StudioPage.test.tsx`.
- [x] 6.6 Update Playwright in `frontend/e2e/drum-machine.spec.ts`, `piano.spec.ts`, and `studio.spec.ts`: a fresh page shows no region and the Loop toggle unpressed and plays once; drawing from an empty ruler creates a region and turns looping on; the toggle with no region loops without drawing one. Verify the Playwright run passes.
- [x] 6.7 Run `just lint` and `just test`, and verify both pass.
- [x] 6.8 Add the "Set loop region" button to `LoopRegion.tsx` (design D3, ui-spec section 9): render it only when `region` is null, visually hidden until focused; Enter or Space commits `{ region: { start: 1, end: 1 }, enabled: true }`, announces it in the live region, and moves focus to the end slider; keep its Space and Enter out of the transport and `useEditorShortcuts` through the `data-loop-region` root. Verify:
  - RTL tests for "Create a region from the keyboard", that Space on the button does not start playback, and that the button is gone once a region exists;
  - a Playwright step in `drum-machine.spec.ts` that tabs to "Set loop region", presses Enter, presses Right on the end slider, and checks the region covers measures 1–2 with looping on;
  - `just lint` and `just test` pass.
- [x] 6.9 Check the code against the reworded default rule and "Replacing the pattern keeps the region" (replacing a pattern by "Start blank" or generation keeps the region and looping setting, clamped). The pattern store is expected to do this already (design D5); add a `patternStore.test.ts` case for the scenario if none exists, and change code only if that test fails. Verify `just test` passes.
