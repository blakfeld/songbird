# Proposal

## Why

A few rough edges in the Studio get in the way of starting and shaping a song. Every new song arrives with a Drums and a Piano track the user often deletes first, which is worse now that the song chat builds the arrangement one track at a time. The piano roll dock can't be put away to give the arrangement room. The chat feels unresponsive: the message you just sent disappears until the reply arrives, and the input locks while you wait.

## What Changes

- **New songs start empty.** First-visit and newly created songs have zero tracks. A song may now hold 0–16 tracks (previously 1–16), so the last track can be deleted. The Studio shows an empty arrangement that invites the user to add a track or ask the chat, and the dock shows an empty state instead of a piano roll. **BREAKING** for the song document's track-count rule: the browser, project-file import, and backend song validation all accept zero tracks. Songs that already have tracks are unchanged.
- **MIDI export of an empty song** yields a file with only the conductor track, instead of being rejected. The Studio disables Export MIDI while the song has no tracks.
- **Add track button spacing.** The Add track control gets breathing room inside the arrangement's top-left header cell, which today is shorter than the button. Visual only.
- **Closable piano roll.** The editor dock gets a Close control. Closing hides the dock and its resize handle and gives the arrangement the full height. Double-clicking a clip, or pressing Enter on a focused clip, opens the dock on that clip again. Whether the dock is open is remembered in this browser and is not part of undo history.
- **Responsive chat.** When the user sends a message, it appears in the chat history immediately, with a pending reply indicator. While the request is in flight, the Send button is disabled and Enter does not send, but the text box stays enabled and focused so the user can draft the next message. If the request fails, the pending message is removed from the history, the error is shown, and the text goes back into the input for a retry.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `songs/multitrack`: the song document allows 0–16 tracks, new songs have no tracks, the last track can be deleted, and the arrangement has an empty state.
- `songs/clips`: the editor dock can be closed and reopened by double-clicking or pressing Enter on a clip.
- `songs/track-generation`: the song chat shows the user's message immediately, disables only the Send action while a request is in flight, and restores the message on failure.
- `songs/export`: MIDI export and project files accept a song with no tracks.

## Impact

- **Frontend:** `lib/song/types.ts` (`newSong`), `lib/song/songOps.ts` (`deleteTrack`), `lib/song/songStore.ts` (selection when there are no tracks), `lib/song/projectFile.ts` (track-count check), `components/studio/StudioPage.tsx` (rendering with no selected track, dock open state, layout), `Arrangement.tsx` and `AddTrackMenu.tsx` (spacing and empty state), `EditorDock.tsx` (close control, no-track state), `ClipLane.tsx` and `useClipActions.ts` (opening the dock), `useChat.ts` and `AssistantPanel.tsx` (pending message, Send disabled), `SongFileActions` (Export MIDI disabled with no tracks).
- **Backend:** `backend/crates/music/src/song.rs` (`validate` allows zero tracks) and the MIDI export path for a song with no tracks. The chat endpoint must accept a song with no tracks.
- **Tests:** Vitest and Playwright tests that assume the default Drums and Piano tracks (`e2e/studio.spec.ts`, `StudioPage.test.tsx`), the "delete last track disabled" test, and the chat in-flight test (`StudioPage.chat.test.tsx`) need updating.
- No new dependencies. Songs already saved in IndexedDB and existing project files still open unchanged.
