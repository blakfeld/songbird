# Tasks

## 1. Song operation and store

- [x] 1.1 Add `moveTrack(song, trackId, toIndex)` to `frontend/src/lib/song/songOps.ts` (clamped, same object on no-op or an unknown id). Verify with `songOps.test.ts` cases for moving up, moving down, the first and last positions, a no-op returning an identical reference, and an unknown id.
- [x] 1.2 Add a `moveTrack` store action that keeps `selectedTrackId` and `selectedClipId`. Verify with `songStore.test.ts`: one undo step per move, undo restoring the order, no history entry for a no-op, and the selection unchanged.

## 2. Menu and keyboard

- [x] 2.1 Add "Move track up" and "Move track down" to the track options menu in `TrackHeader.tsx`, using `aria-disabled` at the ends, matching the Delete item's style. Verify with `StudioPage.test.tsx` cases for "Move from the menu" and "Ends of the list".
- [x] 2.2 Handle Alt+Shift+Up/Down on the header select button, restoring focus after the move, and add the polite live-region announcement in `Arrangement.tsx`. Verify with `StudioPage.test.tsx` "Keyboard move keeps focus", which checks focus and the announced text.

## 3. Drag to reorder

- [x] 3.1 Have `ui-designer` confirm the grip placement and visibility, the lifted-lane style, and the drop indicator (D6). Verify that the design notes are delivered before task 3.2.
- [x] 3.2 Implement the grip handle and the arrangement drag state (D2, D3): pointer capture, a 4 px threshold, midpoint hit-testing in content coordinates, the drop indicator, auto-scroll near the edges, Escape to cancel, and commit on drop. Verify with `StudioPage.test.tsx` "Drag a track up" and "Cancel a drag", using pointer events and stubbed layout.
- [x] 3.3 Add a Playwright test in `frontend/e2e/studio.spec.ts`: drag the third track above the second, check the lane order and track numbers, undo, and check that the original order is back. Verify with `just test-e2e`.

## 4. Integration

- [x] 4.1 Add a test to `backend/crates/api/tests/songs.rs` that exports the same song with two melodic tracks in swapped order and checks that track order and channels follow the array order. Verify that `cargo test -p api` passes and that `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` pass in `backend/`.
- [x] 4.2 Run `just lint` and `just test`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
