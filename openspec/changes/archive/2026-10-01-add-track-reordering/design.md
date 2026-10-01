# Design

## Context

- **Track order:** it is simply the order of `song.tracks`. Lane rendering, track numbers, MIDI export (`song_midi.rs`), and generation-context trimming already read it.
- **Playback:** voices are keyed by track id (`songPlaybackModel.ts:51`), so an array reorder doesn't rebuild audio.
- **Undo:** history lives in `songStore` (past/future, plus gestures for continuous edits).
- **Clip drags:** they use hand-rolled pointer events with a pixel threshold (`ClipLane.tsx`). No drag-and-drop library is installed.
- **Track header:** `TrackHeader.tsx` already has an options `Menu` (Generate, Rename, Delete), and its select button already uses double-click for rename.
- **Live regions:** they exist in `PianoRoll.tsx` and `LoopRegion.tsx`, but not in the Studio arrangement.
- **Arrow keys:** Alt+Left/Right is taken on clips for focus movement. Up/Down is used by `Knob` and `Menu`.

## Goals / Non-Goals

**Goals:**
- Reorder with pointer, keyboard, and menu, all through one `moveTrack` op.
- Keep the move cheap: no audio rebuilds, and one history entry.

**Non-Goals:**
- Moving several tracks at once, track folders or groups, and dragging clips between tracks.
- Reordering through the chat ("move the bass to the top").
- Touch-specific long-press drag. The handle works with touch pointer events, and the menu is the fallback.

## Decisions

### D1. `moveTrack(song, trackId, toIndex)` as the single op
- It splices the track to `toIndex`, which is clamped to the valid range.
- It returns the same `song` object when the index doesn't change or the id is unknown, so the store records nothing for a no-op (the same convention as `setMixer`).
- It needs no `normalizeSong`, because the measures don't change.
- The menu and keyboard call it with `index ± 1`, and a drop calls it with the target index.

### D2. Commit on drop, not live
- During a drag, the store isn't touched. The `Arrangement` holds `{trackId, fromIndex, overIndex}` in local state, and renders the dragged lane lifted plus a 2 px drop indicator between lanes.
- On pointer-up, it calls `moveTrack` once.
- *Why:* there is one undo step with no gesture plumbing, Escape is trivial (drop the local state), and playback and autosave see one change.
- *Alternative:* transient store updates with `beginGesture`, as in clip moves. That was rejected because reordering lanes on every pointer move makes the hit targets shift under the pointer.
- The drop index is computed from the pointer's Y against lane midpoints, which are measured once at drag start.
- A 4 px threshold distinguishes a click on the handle from a drag.
- The arrangement auto-scrolls when the pointer is within 32 px of its top or bottom edge.

### D3. No drag-and-drop library
The handle uses pointer events with `setPointerCapture`, following `ClipLane`'s existing pattern. This keeps the dependency footprint and the interaction model consistent. One axis on a list of at most 16 items doesn't need a library.

### D4. Keyboard: Alt+Shift+Up/Down on the header's select button
- Plain Up/Down and Alt+Up/Down are left free for future vertical focus movement, matching the clips' Alt+Left/Right.
- Alt+Shift+Arrow is a common "move line or item" chord (VS Code, Google Docs lists).
- After the move, focus is restored to the moved header's select button through `data-track-select`, because React re-renders the list in its new order.

### D5. Announcements
`Arrangement` renders a visually hidden `aria-live="polite"` region. After any move (drag, menu, or key), it announces "<name> moved to position <n> of <total>".

### D6. Handle placement
The grip (⋮⋮) sits at the left edge of the header, before the track number. It has `aria-label="Reorder <name>"` and `cursor: grab`, and appears in full only on hover or focus on pointer-fine devices, so the header doesn't get busier. It is only focusable through the header button's key shortcut, so it doesn't add a tab stop per track. `ui-designer` confirms the visual treatment.

## Risks / Trade-offs

- [Pointer drag conflicts with the header's select click and double-click rename] → The drag starts only from the grip, never from the name button.
- [MIDI channels change when tracks reorder] → This is intended and already specified ("in track order"). Users who rely on fixed channels in a DAW will see channels move. It is noted in the scenario so it isn't mistaken for a bug.
- [Auto-scroll and measured midpoints diverge after scrolling] → Measure in content coordinates, which include the scroll offset, not viewport coordinates.
