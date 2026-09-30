# Proposal

## Why

After #4, a song lives only in one browser. It cannot be taken into a DAW, backed up, or moved to another machine. Songwriters need the whole arrangement in their DAW, with each part on its own track and the right sound and balance, and they need a way to keep and share their work without Songbird storing it on a server.

## What Changes

- **Multitrack MIDI export** at `POST /api/v1/songs/export/midi`. It turns a song into a Type 1 Standard MIDI File at 480 PPQ:
  - a conductor track with tempo, time signature, and song name;
  - one track per song track, with its name, a General MIDI Program Change for melodic instruments, CC7 volume and CC10 pan from the mixer, and the notes its clips play. Each track's loops and clips (add-arrangement-clips) are flattened to absolute song notes first, with the same algorithm the browser uses for playback.
- **Channel assignment**: drums tracks use channel 10. Melodic tracks get channels 1–9 and then 11–16 in track order.
- A **"Download MIDI"** action on the Studio page names the file `songbird-<song-name>-<bpm>bpm.mid`.
- **Song project files**: "Download project" saves the song as `<song-name>.songbird.json`, and "Open project" loads one into the browser library. Import checks the format, version, instruments, and value ranges, and rejects bad files with a clear message.
- **Song types move to the backend** (`music` crate) and are generated into the frontend with ts-rs. This replaces the hand-written TypeScript types from #4 and add-arrangement-clips, including `Loop` and `Clip` (song document `version` 2).
- **Clip validation and flattening in Rust**: the backend checks loops and clips with the same rules as the browser's `validateClips`, and ports `resolveTrackNotes` as `resolve_track_notes`. A shared fixture, `fixtures/clip_resolution.json`, is run by both the Rust tests and the frontend `resolveTrackNotes` Vitest so the two flatteners cannot drift.
- **Request size limit**: routes under `/api/v1/songs/` and `/api/v1/lyrics/` accept bodies up to 1 MiB, because songs are larger than patterns. Every other route keeps the 64 KiB limit.
- **Non-goals**:
  - Audio (WAV/MP3) rendering.
  - MIDI import.
  - Cloud storage or share links.
  - Exporting only the soloed or unmuted tracks. Every track is exported, because muting is an audition choice rather than an arrangement choice.

Depends on: #4 `add-multitrack-song` and `add-arrangement-clips` (the loop and clip song document, `version` 2, `validateClips`, and `resolveTrackNotes`). It also relies on #1 for `midi_program`.

## Capabilities

### New Capabilities
- `songs/export`: Multitrack MIDI export of a song, and song project file download and upload.

### Modified Capabilities
- `platform/service-operations`: "Request size limit" allows 1 MiB bodies for song and lyrics routes.

## Impact

- **Backend (`music` crate)**:
  - New `song.rs`, with `Song`, `Track`, `Loop`, `Clip`, validation against the instrument registry, and `resolve_track_notes`.
  - New `song_midi.rs`, which shares note settling and tick conversion with `midi.rs`.
  - Song types are added to `tests/ts_bindings.rs`.
  - New shared fixture `fixtures/clip_resolution.json`, also consumed by the frontend `resolveTrackNotes` Vitest.
- **Backend (`api` crate)**:
  - New `songs.rs` router.
  - `routes.rs` gets a per-route body limit.
  - `ApiError` gets an `InvalidSong` variant (`422 invalid_song`).
- **Frontend**:
  - `lib/song/types.ts` is replaced by the generated types.
  - New `lib/song/projectFile.ts` (serialize and validate).
  - New Studio toolbar actions: Download MIDI, Download project, and Open project.
  - `lib/api.ts` gets `exportSongMidi`.
- **Compatibility**: additive.
