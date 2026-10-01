# Proposal

## Why

Track order is fixed by the order tracks were added. Users can't group related parts, for example drums and bass together or the lead on top. A part added late through the chat always ends up at the bottom. Track order also matters beyond the screen: it sets MIDI channel assignment, the track order in the exported file, and which tracks are dropped first when the generation context is trimmed.

## What Changes

- **Drag to reorder.** Each track header gets a drag handle. Dragging it up or down moves the whole track, with its lane, mixer, sound settings, loops, and clips, to a new position, and a drop indicator shows where it will land. Escape cancels the drag.
- **Keyboard and menu.** "Move track up" and "Move track down" are added to the track options menu. With focus on a track header, Alt+Shift+Up and Alt+Shift+Down move the track. Each move is announced to screen readers, for example "Bass moved to position 2 of 4".
- **Undoable.** Each completed move is one undo step. A drag dropped back where it started records nothing.
- **What follows the order.** Track numbers, lanes, MIDI export order and channels, and the generation context's trimming order all follow the new order, as they already follow the song's track order. Selection, playback, and focus stay on the moved track.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `songs/multitrack`: adds a "Reorder tracks" requirement. The existing requirements already define behavior in terms of track order, so they don't change.

## Impact

- **Frontend:**
  - `lib/song/songOps.ts`: new `moveTrack`, returning the same object for a no-op.
  - `lib/song/songStore.ts`: a store action that keeps the selection.
  - `components/studio/TrackHeader.tsx`: grip handle, menu items, and key handling.
  - `components/studio/Arrangement.tsx`: drag state, drop indicator, and a live-region announcement.
  - `StudioPage.tsx`: wiring.
- **Backend:** none. The order of the `tracks` array is already the song's track order, and the document shape doesn't change.
- **Tests:** Vitest for `moveTrack`, undo, the menu, keyboard, and drag. A Playwright drag in `e2e/studio.spec.ts`.
