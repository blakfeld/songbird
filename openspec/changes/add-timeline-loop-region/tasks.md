# Tasks

## 1. Loop model and engine

- [ ] 1.1 Add `frontend/src/lib/loopRegion.ts` with `LoopSetting`, `defaultLoop`, `clampLoop`, `drawRegion`, `moveRegion`, `resizeStart`, and `resizeEnd` (design D1). Verify with Vitest cases for the helper behind each spec scenario:
  - "Draw backwards", "Move stops at the end", and "Resize keeps one measure";
  - "Shortening clamps a partial region" and "A whole-length region grows with the pattern".
- [ ] 1.2 In `lib/audio/engine.ts`, add `setLooping(enabled)` and the play-once ending (design D2):
  - `nextMeasure` counts on past the region when looping is off;
  - the end is detected when the previous measure is the last one;
  - a finish timer waits for the last bar plus note tails, then calls `stop()`;
  - `play()` clears `jumpTo` while looping is on.
  - Verify the existing `setLoop` and `seek` tests in `engine.test.ts` pass unchanged. Add tests for:
    - "Play once with looping off" and "Last note rings out";
    - "Turn looping off mid-play" and "Turn looping on outside the region";
    - Stop before the finish timer fires;
    - Play immediately after an automatic stop.
- [ ] 1.3 Change `usePlayback` and `useSongPlayback` to take a `LoopSetting` and push `setLoop` and `setLooping`. Verify with `pnpm typecheck` and the existing playback hook tests.

## 2. Persistence

- [ ] 2.1 Add `loop` and `setLoop` to the pattern store in `lib/patternStore.ts`, include `loop` in `partialize`, and use `defaultLoop` when it is missing. Apply `clampLoop` on `setMeasures` and whenever the pattern is replaced (design D5). Verify Vitest tests for:
  - "Reload restores the region" (persisted round trip);
  - a stored pattern with no `loop` loads with looping on and the whole length;
  - "Region changes are not undo steps".
- [ ] 2.2 Add the optional `Song.loop_region` field and clamp or default it on load in `migrate.ts`. In `songStore.ts`, add `setLoop` with no history push, apply `withLiveLoop` in undo, redo, and gesture cancel and commit, and apply `clampLoop` in `setSongLength` (design D5). Verify Vitest tests for:
  - undo, redo, and a cancelled gesture leave the region unchanged;
  - an undo that changes the length clamps the region;
  - autosave writes a region change;
  - duplicating a song copies the region;
  - a version 2 song without the field opens looping the whole song.

## 3. Ruler and transport UI

- [ ] 3.1 Have `ui-designer` specify the `LoopRegion` visuals:
  - the enabled and disabled region styles, and the edge handles with their hit areas;
  - the cursors for draw, move, and resize, and the focus rings;
  - the Loop toggle's icon, label, and pressed state beside Play;
  - how the region reads on the fit-to-width Studio ruler at 128 measures.
  - Verify the result is recorded as `openspec/changes/add-timeline-loop-region/ui-spec.md`.
- [ ] 3.2 Build `components/editor/LoopRegion.tsx` over `MeasureRuler` (design D3):
  - pointer capture with a 4px drag threshold;
  - draw, move, and resize, with preview during the drag and a single commit on release;
  - click on the body toggles;
  - the edge sliders and a body toggle with keyboard support, and Space and Enter kept from reaching the transport.
  - Remove the loop `data-*` attributes from `MeasureRuler`, and show `LoopShade` only while looping is on and the region is not the whole length.
  - Verify RTL tests for every scenario under "Editing the loop region on the ruler".
- [ ] 3.3 In `Transport.tsx`, replace the loop `Select`s and the "Loop whole …" button with the Loop playback toggle (design D4). Rewrite the loop cases in `Transport.test.tsx`. Verify an RTL test for "Toggle beside Play", and that no "Loop start measure" or "Loop end measure" control remains.

## 4. Page wiring

- [ ] 4.1 In `PatternEditorPage`:
  - drop `loopState` and read `loop` from the pattern store;
  - mount `LoopRegion` on the `PianoRoll` ruler through the `loop` and `onLoopChange` props;
  - pass the loop to `Transport` and `usePlayback`.
  - Verify with RTL tests: drawing a region on `/drum-machine` updates the transport toggle and the engine loop, and reload restores it.
- [ ] 4.2 In `StudioPage` and `Arrangement`:
  - drop `loopState` and the per-open reset, and read `loop_region` from the song store;
  - mount `LoopRegion` on the arrangement ruler, and keep the dock's `PianoRoll` without it;
  - with looping on, stop lane seeking from overriding where Play starts.
  - Verify RTL tests for "Loop a range across tracks", "Song plays once", "Seek with looping off", and "Region is not in the dock". Rewrite the length-change assertion in `StudioPage.test.tsx` that used "Loop end measure".

## 5. Downstream planning and integration checks

- [ ] 5.1 Run `/opsx:update` on `add-song-sections` and `add-context-aware-track-generation`:
  - selecting a section sets the loop region and turns looping on;
  - the "Loop range" generation option requires looping on and a region that is not the whole length;
  - replace stale `Transport.tsx:16-17` citations.
  - Verify `openspec validate` passes for both changes.
- [ ] 5.2 Add Playwright coverage in `frontend/e2e/studio.spec.ts` and `frontend/e2e/drum-machine.spec.ts`: drag a region on the ruler, toggle looping by clicking the region and with the transport button, reload and check that both persist, and turn looping off and check that playback stops by itself. Verify the Playwright run passes.
- [ ] 5.3 Run `just lint` and `just test`, and verify both pass.
