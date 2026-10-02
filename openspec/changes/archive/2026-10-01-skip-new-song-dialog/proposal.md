# Proposal

## Why

Creating a song opens a dialog that asks for a name and a time signature before anything else can happen. Most people don't know the song's name yet. The time signature can already be changed at any time from song settings, so the dialog's "Can't be changed after the song is created" hint is no longer true. The dialog is a stop between the user and the empty song for no benefit.

## What Changes

- **No dialog.** "New song" in the Songs library creates and opens a song immediately, with the defaults: no name prompt, no time-signature prompt, and no confirmation step.
- **Default name.** The new song is named "Untitled song". If a song with that name already exists, it is named "Untitled song 2", "Untitled song 3", and so on, so the library list stays readable.
- **Renaming later.** Users rename a song from the song header, as they can today, and change the time signature from song settings.
- **Cleanup.** The `NewSongDialog` component is removed, and the menu item loses its trailing ellipsis ("New song…" → "New song"), because it no longer opens a dialog.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `songs/multitrack`: adds a "Creating a song" requirement that says New song creates the song immediately, with a unique default name and no prompt. The existing "New song defaults" scenario is unchanged.

## Impact

- **Frontend:** `components/studio/SongLibraryMenu.tsx` (create directly), a new `uniqueUntitledName` helper in `lib/song/` (or next to `newSong` in `types.ts`), and `components/studio/NewSongDialog.tsx` (deleted).
- **Tests:**
  - `StudioPage.test.tsx` and any library-menu tests.
  - The e2e flows that fill the dialog: `e2e/studio.spec.ts` lines 17, 122, and 185, and `e2e/midi-recording.spec.ts` line 77. They switch to "New song" followed by a rename through the song header, wrapped in a shared helper in `e2e/studioHelpers.ts`.
- **No backend change.**
