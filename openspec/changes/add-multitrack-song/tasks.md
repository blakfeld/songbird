# Tasks

## 1. Song model and pure operations

- [ ] 1.1 Add `frontend/src/lib/song/types.ts` with `Song`/`Track` per design D1 (reusing generated `Note`/`TimeSignature`) and `newSong()` defaults (Drums + Piano, 8 measures, 4/4, 120 BPM); verify a Vitest test asserts the "New song defaults" scenario
- [ ] 1.2 Extract `NoteGrid` note operations from `lib/patternOps.ts` (design D2) keeping `Pattern` wrappers; verify existing `patternStore.test.ts` and `PianoRoll.test.tsx` pass unchanged
- [ ] 1.3 Implement `lib/song/songOps.ts`: `addTrack` (≤ 16), `deleteTrack` (≥ 1), `renameTrack`, `editTrackNotes`, `setMixer`, `setSongLength` (append empty / truncate), `setTempo`, `setSwing`, `renameSong`, `audibleTracks` (mute/solo rules), `addTrackFromPattern`; verify Vitest cases for every scenario under "Tracks with one instrument each", "Song settings", and "Track mixer" solo/mute rules

## 2. Playback engine generalization

- [ ] 2.1 Add optional `output` node to `SoundSourceFactory` and route every source to `output ?? destination`: `drumsSource.ts`, and #2's `createSynthSource` in `lib/audio/synthSource.ts` (the end of each preset's effect chain, so all of #3's presets and the fallback preset are covered). Keep the single-instrument pages and #2's key audition on the default destination. Verify that the existing drums and synth playback tests still pass, and add a test per source kind (drums, a preset with an effect chain, the fallback preset) asserting it connects to a supplied node and never to the destination
- [ ] 2.2 Refactor `lib/audio/engine.ts` to depend on a `PlaybackModel` (timing + voices) per design D4, with a single-voice adapter over the pattern store; verify all existing `engine.test.ts` tests pass unmodified apart from construction
- [ ] 2.3 Add per-voice `Tone.Channel` creation, `rampTo` volume/pan updates each tick, audibility muting, and disposal of removed voices; verify engine tests for two voices starting at the same step, a solo change silencing other voices, pan −1 channel parameter, and a volume change without transport restart

## 3. Song store and browser library

- [ ] 3.1 Add `idb-keyval` dependency; verify `pnpm install` and `pnpm typecheck` pass
- [ ] 3.2 Implement `lib/song/songStore.ts` with history (100 entries), gesture coalescing for mixer drags, and non-recorded selection; verify Vitest tests for "Undo a track deletion" and "One drag, one undo step"
- [ ] 3.3 Implement `lib/song/songLibrary.ts` (IndexedDB bodies + index record with `name`, `time_signature`, `updated_at`; debounced save; last-opened id in localStorage; create/open/rename/duplicate/delete); verify Vitest tests with `fake-indexeddb` for reload restore, "Duplicate a song" independence, delete, the storage-failure message path, and a stored song with an unrecognised extra field saving back with that field unchanged (design D3)

## 4. Studio UI

- [ ] 4.1 Have `ui-designer` produce a layout spec for the Studio page from `mockups/studio.png` (arrangement with track headers and lanes, editor dock, assistant column, song header, library menu) per design D5; verify the spec is recorded in this change as `ui-spec.md`, with any departures from the mockup explained
- [ ] 4.2 Build `app/studio/page.tsx`, `StudioPage`, `SongHeader` (name, tempo, swing, length; time signature read-only), and `NewSongDialog` (time signature choice); verify RTL tests for rename, length change, and read-only time signature
- [ ] 4.3 Build `TrackLane`, `TrackHeader` (number, instrument icon, name, Mute, Solo, volume slider −60…+6 dB, pan knob with center reset, accessible labels), `NoteOverview` (miniature notes, one SVG path per lane), and add/rename/delete track controls with limits; verify RTL tests for the add-limit and last-track-delete scenarios, and that a placed note appears in its lane's overview
- [ ] 4.4 Wire the selected track into `PianoRoll` via the `NoteGrid` props and the song transport (Play/Stop/Space/loop/playhead across lanes); verify RTL test "Edit the selected track" and "Switching tracks keeps edits"
- [ ] 4.5 Add the undo/redo buttons and Cmd/Ctrl+Z shortcuts on the Studio page, skipping text-entry targets via `isTextEntryTarget`; verify an RTL keyboard test
- [ ] 4.6 Add a Studio entry to the landing page (`app/page.tsx`); verify `page.test.tsx` asserts the link
- [ ] 4.7 Build the `AssistantPanel` shell in the right-hand column (chat history area with an empty state, disabled chat input) per design D5; verify an RTL test that the column, empty state, and disabled input render

## 5. Send to song

- [ ] 5.1 Add `SendToSongButton` + dialog to `EditorToolbar` per design D6 (matching time signature filter, new-song option, 16-track limit, song lengthening); verify RTL tests for the three "Send pattern to a song" scenarios

## 6. End-to-end and integration checks

- [ ] 6.1 Add Playwright `frontend/e2e/studio.spec.ts`: create song, add a bass track, place notes on two tracks, solo one, reload, and verify notes and mixer state persist
- [ ] 6.2 Run `just lint` and `just test`; verify both pass (existing drum-machine e2e included)
- [ ] 6.3 Manually play a 16-track, 32-measure song in Chrome and Safari; record audible glitches (if any) and polyphony settings in `frontend/README.md` or this change's design Risks
- [ ] 6.4 Run `openspec validate add-multitrack-song --strict`; verify it passes
