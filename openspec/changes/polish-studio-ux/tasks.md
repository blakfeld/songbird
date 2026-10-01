# Tasks

## 1. Backend: accept songs with no tracks

- [x] 1.1 In `backend/crates/music/src/song.rs`, let `Song::validate` accept zero tracks while still rejecting more than 16, and update the error message and the unit test that expected `track_count` for an empty song. Verify with a unit test showing an empty song is valid and a 17-track song is not.
- [x] 1.2 Add an API test that posts an empty song to the MIDI export endpoint and gets `200` with a conductor-only SMF. Add another that posts an empty song to the song chat endpoint and confirms it is not rejected for its track count. Verify that `cargo test`, `cargo fmt --all`, and `cargo clippy --workspace --all-targets -- -D warnings` pass in `backend/`.

## 2. Frontend song model: zero tracks and empty new songs

- [x] 2.1 Make `newSong()` in `lib/song/types.ts` return no tracks, and update `types.test.ts`. Verify the test asserts the defaults from the "New song defaults" scenario.
- [x] 2.2 Remove the minimum-of-one guard from `songOps.deleteTrack`, and replace the "refuses to delete the last track" test with one that deletes the last track. Add a `songStore` test showing that deleting the only track leaves the selection null and that undo restores the track with its loops, clips, and mixer values.
- [x] 2.3 Allow 0–16 tracks in the `projectFile.ts` import check. Verify with tests that a zero-track project imports and a 17-track project is rejected.
- [x] 2.4 Add a test fixture helper that builds a song with Drums and Piano tracks. Move the `songOps`, `songStore`, and other unit tests that relied on `newSong()`'s default tracks onto it. Verify that `npm test` passes for `lib/song`.

## 3. Studio: empty arrangement and track deletion

- [x] 3.1 Gate the `StudioPage` layout on `song` alone and make the selected track nullable. Keep `TrackGenerateDialog` and recording gated on a track, and make the dock `ResizeObserver` effect tolerate a missing dock element. Verify with a `StudioPage` test that an empty song renders the Studio, not the loading skeleton.
- [x] 3.2 Render the empty-arrangement state in `Arrangement`: the ruler, Add Track, and a message inviting the user to add a track or describe a part in the chat. Render a `NoTracksDock` empty state in place of `EditorDock` when there is no track. Verify with tests for the "Empty song" and "First track in an empty song" scenarios.
- [x] 3.3 Make every track deletable. Remove `canDelete` and the "at least one track" hint from `Arrangement` and `TrackHeader`, and replace the "disables Delete when only one track is left" test with a "Delete the last track" test.
- [x] 3.4 Disable Download MIDI in `SongFileActions` when the song has no tracks. Verify with a `SongFileActions` test for the "Nothing to download" scenario.
- [x] 3.5 Update `StudioPage.test.tsx` and the other Studio unit tests that assume the default Drums and Piano lanes. Verify that `npm test` passes in `frontend/`.

## 4. Add Track spacing

- [x] 4.1 Give the arrangement header cell and the ruler row a matching height and padding, so the Add Track button has visible space on every side and is clear of the track counter. Verify visually in the running app at desktop and narrow widths, and confirm the ruler stays aligned with the lanes.

## 5. Closable editor dock

- [x] 5.1 Generalise `useStoredHeight` into `useStoredValue<T>`, keeping `useStoredHeight` as a wrapper. Verify that `useStoredHeight.test.ts` still passes and that a new test covers storing a boolean, including the fallback when storage is blocked.
- [x] 5.2 Add the dock-open flag (`songbird.studio.dockOpen`, default open) to `StudioPage`, and a labelled Close control to the dock header and the empty-state docks. When the dock is closed, drop the handle and dock grid rows, and hide the "Skip to piano roll" link. Verify with tests that closing hides the dock and handle, keeps the selection, persists across a remount, is not undone by Cmd/Ctrl+Z, and that reopening restores the stored height.
- [x] 5.3 Pass `openDock` into `useClipActions`. Clip double-click, Enter on a focused clip (calling `preventDefault` so the native click does not also fire), and creating a clip by double-clicking an empty lane should all select the clip and open the dock. A single click should only select. Add "Enter" to `CLIP_KEYS_HELP` and `aria-keyshortcuts`. Verify with tests for the "Single click does not reopen", "Double-click reopens on the clip", and "Keyboard reopen" scenarios.

## 6. Responsive chat

- [x] 6.1 Add `pending` to `useChat`, and make `send` resolve with the outcome so the caller can restore its text. Clear `pending` on success, on failure, and on song reload (the `loadEpoch` guard). Verify with hook-level or `StudioPage.chat` tests.
- [x] 6.2 In `AssistantPanel`, clear the draft on submit, render the pending message followed by the "Thinking…" indicator, keep the textarea enabled and focused while a request is in flight, disable only Send and Enter-to-send, and restore the failed text into an empty draft. Replace the "disables the input while a request is in flight" test, and add tests for "Sent message appears immediately", "Send is disabled while waiting", and "Failed message goes back to the input" (including the case where the draft is not empty). Verify that `StudioPage.chat.test.tsx` passes.

## 7. End-to-end and integration

- [x] 7.1 Update `e2e/studio.spec.ts` and `e2e/midi-recording.spec.ts` to start from an empty song and add the tracks they need. Add e2e coverage for closing and reopening the dock by double-click and checking that it stays closed after a reload, and for the chat input staying typeable while a reply is pending. Verify that the Playwright suite passes.
- [x] 7.2 Run `just lint` and the full frontend and backend test suites, and confirm they pass.
