# Design

## Context

See proposal.md for motivation and the delta specs for requirements. The current code shapes the approach in these ways:

- **Minimum of one track.** The rule is enforced in four places: `songOps.deleteTrack` (`frontend/src/lib/song/songOps.ts:124`), the project-file import check (`projectFile.ts:154`), `Arrangement`'s `canDelete={tracks.length > 1}` together with the hint in `TrackHeader`, and the backend `Song::validate` (`backend/crates/music/src/song.rs:336`). Loading from IndexedDB (`migrate.ts`) already accepts an empty list. MIDI export (`song_midi.rs`) and the chat planner (`chat.rs`) never index into the tracks, so the only thing stopping them on an empty song is `validate`.
- **Studio render gate.** `StudioPage` renders the arrangement and the dock only when `song && track` is true, where `track` is the selected track or `tracks[0]`. Otherwise it shows the "Loading song…" skeleton. With zero tracks, the Studio would stay on that skeleton forever.
- **Selection.** Selection is already nullable. `songStore.validSelection` falls back to `tracks[0]`, then to `null`, after every edit. `addTrack` and `applyChatResult` select the new track.
- **Dock layout.** `<main>` is a four-row grid: header, arrangement (`--arr-rows`), `HeightHandle`, and dock (`--dock-rows`). The dock height lives in localStorage through `useStoredHeight`, a `useSyncExternalStore` hook with an in-memory fallback, and it only stores numbers.
- **Clips.** Clips are `<button>`s. Click selects. Double-click selects, then `focusRoll()` focuses the piano roll on the next frame. Double-clicking an empty lane calls `actions.create`. Pressing Enter only fires the native click.
- **Chat.** The user message only enters `song.chat` with the reply, in `applyChatResult`. `useChat` holds `sending` and `error` state. `AssistantPanel` disables both the textarea and Send while `sending`, and clears its local `draft` only after a successful send. The panel is mounted twice, in the desktop aside and in the mobile dialog, and both mounts share one `useChat`.

## Goals / Non-Goals

**Goals:**
- Treat an empty song as a normal, fully usable state everywhere, not as a loading state.
- Keep the dock's open state as a per-browser preference, beside its stored height.
- Make chat sending optimistic in the UI only, without touching the song document until the reply arrives.

**Non-Goals:**
- Migrating existing songs. Saved songs keep their tracks.
- Showing a closed dock on mobile. The dock and its handle are already laid out differently there, and Close behaves the same at every width.
- Changing how chat entries relate to undo. A track added from the chat stays one undo step that includes its chat entries.

## Decisions

### 1. Allow zero tracks by deleting the minimum, not by adding special cases
Every "≥ 1" guard is removed: `deleteTrack`, the project-file check, `canDelete`, the `TrackHeader` hint, and the backend `validate`. The maximum of 16 stays. The backend error message becomes "at most 16 tracks". `validate` keeps its check order, which mirrors the browser.
*Alternative:* allowing zero tracks only for new songs. Rejected, because the spec makes the last track deletable, and a song can then be saved and re-imported with zero tracks anyway.

### 2. Gate the Studio on `song`, and make the selected track optional
`StudioPage` renders the layout whenever a song is loaded. `track` becomes `Track | null`. When it is null:
- `Arrangement` renders the ruler, the header cell with Add Track, and an empty-state message in place of the lanes.
- The dock renders a `NoTracksDock` empty state in `StudioPage` instead of `EditorDock`. `EditorDock` keeps its non-null `track` prop, so its internals don't change.
- `TrackGenerateDialog` and recording stay gated on a track, as they are today.
- The `ResizeObserver` effect that reads `#studio-editor` tolerates a missing element, because the dock may also be closed (see decision 3).

*Alternative:* making `EditorDock` accept a null track. Rejected, because every child of `EditorDock` assumes a track and an instrument.

### 3. Store the dock's open state with a generic stored-value hook
`useStoredHeight` is generalised into `useStoredValue<T>(key, fallback, parse)`, which keeps the same external store, fallback map, `storage` listener, and try/catch. `useStoredHeight` becomes a thin wrapper, so its callers and tests don't change. The dock uses `useStoredValue<boolean>("songbird.studio.dockOpen", true)`.

When the dock is closed, the grid template drops the handle and dock rows: `auto 1fr` on desktop. The handle and the dock are not rendered. The stored dock height is left alone, so reopening restores it for free. Because this is UI state outside `songStore`, it never touches the song or undo history.
*Alternative:* a second, boolean-only hook copied from `useStoredHeight`. Rejected because it would duplicate the subtle storage-fallback code.

### 4. Open the dock from clip actions
`useClipActions` receives an `openDock()` callback from `StudioPage`, which sets the stored flag to true. The actions call it as follows:
- **Double-click on a clip:** select, then `openDock()`, then `focusRoll()`.
- **Enter on a focused clip:** `ClipLane`'s `onKeyDown` handles Enter. It calls `preventDefault` so the native click doesn't fire as well, then selects the clip and calls `openDock()`. Unlike double-click it does not focus the roll, because the spec keeps Enter's behaviour unchanged while the dock is open, and before this change Enter only selected. "Enter" is added to `CLIP_KEYS_HELP` and `aria-keyshortcuts`.
- **`create` from an empty-lane double-click:** creates the clip, selects it, then calls `openDock()`.

A single click stays select-only. `focusRoll` already waits a frame. The state update from a discrete event commits before that frame, so the roll exists by the time it runs.

### 5. Hold the pending chat message in `useChat`, not in the song
`useChat` gains `pending: string | null`, set when a send starts and cleared when it settles. Because both panel mounts read it from the shared hook, both show the pending message. `AssistantPanel` renders `song.chat` followed by the pending user message and the existing "Thinking…" status.

Sending works like this:
- **On submit:** the panel clears its draft immediately.
- **On success:** `applyChatResult` appends the user and assistant entries, so they are saved and undone together, as before. `pending` is cleared in the same tick.
- **On failure:** `pending` is cleared and `error` is set. `send` resolves `false` with the text. The panel that sent the message restores it into its draft only if the draft is still empty.
- **While a request is in flight:** the textarea is no longer disabled. Send is disabled, and the form's submit handler (which Enter reaches through `requestSubmit`) returns early.

The `loadEpoch` guard also clears `pending` when a different song loads.
*Alternative:* writing the user entry into `song.chat` up front and removing it on failure. Rejected, because the entry would be saved to IndexedDB and would complicate undo, both of which the spec forbids.

### 6. Disable Download MIDI on an empty song
`SongFileActions` disables the button when `busy || song.tracks.length === 0`. Download project stays enabled. The backend still accepts an empty song and returns a conductor-only SMF, as the export spec requires for API clients.

### 7. Add-track spacing
The arrangement header cell and the measure-ruler row are `h-7`, but the Add Track button is `h-8`. Both cells of that row get the same taller height, with vertical padding so the button has a gap on every side, which keeps the ruler aligned with the header cell. The counter keeps its `gap-2`, with horizontal padding at both breakpoints. This is a styling-only change, reviewed visually at desktop and narrow widths.

## Risks / Trade-offs

- [Tests assume the default Drums and Piano tracks in many places] → Unit tests that only need *some* tracks build them explicitly through a small fixture helper, instead of relying on `newSong()`. E2E specs add the tracks they need through the Add Track menu.
- [The dock flag is shared across songs and tabs] → This is intended by the spec ("across reloads and songs"). The `storage` listener keeps open tabs in sync.
- [A pending message is lost if the user navigates away mid-request] → Acceptable. It was never saved, and the spec says it isn't saved until the reply arrives.
- [Closing the dock removes the "Skip to piano roll" target] → The skip link is hidden while the dock is closed.

## Migration Plan

No data migration is needed. The frontend and backend are deployed together. An older backend would reject empty songs on export and chat, but the Studio already disables Download MIDI for empty songs. Rolling back means reverting both sides. After a rollback, any empty song saved in the meantime would sit on the "Loading song…" skeleton. The user can recover by creating a new song, which is acceptable for this project's single-deploy setup.
