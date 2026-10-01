# Proposal

## Why

Every sound in a Songbird song comes from a built-in synth or the bundled drum kit. Songwriters also want audio from outside: drum loops, vocal chops, one-shots, field recordings, and stems from other sessions, placed in time with their generated parts. Recording from a microphone (`add-audio-recording`) and playing samples from notes (`add-sampler-instrument`) both need the same base underneath: audio tracks, audio clips, a place to keep audio, and a way to play it in sync. This change builds that base and the simplest way to fill it, which is importing audio files.

## What Changes

- **Audio tracks.** A new track type, chosen with "Audio" in Add Track. Audio tracks hold audio clips instead of notes. They have the normal header, mixer, mute and solo, and the per-track effects from `add-track-sound-controls`. They count toward the 16-track limit. The editor dock shows a clip panel instead of a piano roll.
- **Song samples.** The song lists the audio its clips use as `samples`: metadata only, with name, sample rate, channels, length, and origin. The audio itself is never inside the song document.
- **Importing audio files.**
  - Drop a file on an audio lane, or use "Import audio…", to add a sample. Accepted formats are those the browser can decode: WAV, AIFF, MP3, AAC/M4A, and FLAC, plus Ogg/Opus where supported. Files can be up to 200 MB and 20 minutes long.
  - Dropping a file on the empty arrangement creates an audio track for it.
  - Imported audio is decoded once and stored losslessly in the browser.
- **Sample library.** A Samples panel lists every sample imported in this browser, across songs. It offers search by name, a preview button, rename, and remove from the library. Drag a sample onto an audio lane, or press Enter on it, to place it at the playhead. Removing a sample from the library doesn't break songs that use it.
- **Clip editing.**
  - Move clips, snapped to sixteenths unless Shift is held.
  - Trim either edge without destroying audio.
  - **Loop:** extending a looping clip repeats its slice, for drum loops.
  - Gain, fade-in, and fade-out.
  - Duplicate, delete, and "Replace sample", which swaps in another library sample in place.
  - Waveforms are drawn on the lane, and every edit is undoable.
- **Playback.** Clips play sample-accurately in sync with notes, through the track's effects and mixer. Tempo changes move where clips start but never stretch them.
- **Storage.** Sample audio lives in the browser (IndexedDB) and is shared by every song that uses it. It is deleted only when no song and no library entry refers to it. The Studio asks the browser to keep its storage persistent, and warns when space is low.
- **Export.**
  - "Download WAV" renders the whole song as heard.
  - MIDI export leaves audio tracks out.
  - A song that uses samples downloads as a `.songbird.zip` bundle with the audio inside, and Open project accepts bundles.
- **AI.** The chat never creates audio tracks. Generation isn't offered on them. They aren't sent as context.
- **Out of scope:**
  - microphone recording (`add-audio-recording`);
  - playing samples from notes (`add-sampler-instrument`);
  - time-stretching or tempo-syncing loops;
  - a bundled starter sample pack, because of licensing; it is a possible follow-up;
  - server-side storage of audio, a follow-up to `add-user-accounts`.

## Capabilities

### New Capabilities
- `songs/audio-tracks`: the audio track and audio clip document, song samples, playback, song length, lane display, clip editing (move, trim, loop, gain, fades, replace), the dock clip panel, and browser storage and cleanup of sample audio.
- `songs/sample-library`: importing audio files, the browser-wide sample library (list, search, preview, rename, remove), and placing library samples on audio tracks.

### Modified Capabilities
- `songs/export`: MIDI files leave out audio tracks. Adds the WAV mixdown, and project bundles for songs that use samples.
- `songs/track-generation`: audio tracks are never created by the chat, can't be generated into, and aren't used as context.

## Impact

- **Frontend audio:**
  - The `engine.ts` audio-clip scheduling path (pooled `Tone.Player`s, gain and fades, looping, routing into the track `InsertChain`).
  - Offline mixdown with `Tone.Offline`.
  - File decoding through `decodeAudioData`.
  - Waveform overview computation in a worker.
- **Frontend song:**
  - Generated types for `Sample` and `AudioClip`.
  - `audioClipOps`, plus audio-clip awareness in `derivedMeasures`/`setTempo`.
  - TS validation through shared fixtures.
  - `migrate.ts`.
- **Frontend storage:**
  - New `lib/audio/sampleStore.ts` (IndexedDB audio blobs keyed by sample id).
  - `lib/audio/sampleLibrary.ts` (library index).
  - Cleanup hooks in `songLibrary` open, delete, and duplicate.
  - `projectFile.ts` bundles via `fflate`.
- **Frontend UI:**
  - The Add Track "Audio" entry.
  - Audio lanes in `ClipLane`.
  - The dock clip panel.
  - A new `SamplesPanel`.
  - Drop targets.
  - "Download WAV" in `SongFileActions`.
- **Backend:**
  - `music::song` accepts the reserved `audio` instrument id, `song.samples`, and `track.audio_clips`, and validates them.
  - `song_midi.rs` skips audio tracks.
  - `context.rs` and `chat.rs` exclude them.
  - Generation rejects an audio target.
  - Schema snapshot, TS bindings, and shared fixtures.
- **Dependencies:** `fflate`.
- **Depends on:** `add-track-sound-controls` (`InsertChain` wired in `engine.ts`).
- **Other changes:** `add-audio-recording` and `add-sampler-instrument` build on this change.
