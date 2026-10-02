# Tasks

## 1. Create songs without the dialog

- [x] 1.1 Add `uniqueUntitledName(existingNames: string[])` in `frontend/src/lib/song/` next to `newSong`. It returns "Untitled song" or the smallest free "Untitled song N", comparing names case-insensitively after trimming. Verify with unit tests for the empty list, an existing "Untitled song", gap reuse, and case and whitespace variants.
- [x] 1.2 In `SongLibraryMenu.tsx`, make "New song" (no ellipsis) call `library.create({ ...newSong(), name: uniqueUntitledName(entries) })`, close the library, and call `onCreated`. Delete `NewSongDialog.tsx` and its imports. Verify that `tsc` passes, and add `StudioPage.test.tsx` cases for "New song opens immediately" (no dialog role appears) and "Default names stay distinct".

## 2. Update end-to-end flows

- [x] 2.1 Add a `newSong(page, name)` helper to `frontend/e2e/studioHelpers.ts`. It opens Songs, clicks "New song", and renames the song through the song header's rename button, matched by `/^Rename song Untitled song( \d+)?$/`. A first visit already creates "Untitled song", so the new song is usually "Untitled song 2". Replace the dialog-filling code in `e2e/studio.spec.ts` (around lines 17, 122, and 185) and `e2e/midi-recording.spec.ts` (around line 77) with it. Verify with `just test-e2e`.

## 3. Integration

- [x] 3.1 Run `pnpm lint`, `tsc`, and `pnpm build` in `frontend/`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
