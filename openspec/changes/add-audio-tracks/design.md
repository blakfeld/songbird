# Design

## Context

- **Playback:** `lib/audio/engine.ts` uses a custom step scheduler. A `tick` is scheduled via `transport.scheduleOnce` with `LOOKAHEAD_SECONDS = 0.1`, and it reads notes per step. Bars are tracked by `transportStart`, and steps map to seconds through `stepToSeconds(step, tempo, swing)`. The playhead reads the audio clock.
- **Per-track graph:** source → `InsertChain` (from `add-track-sound-controls`) → `Tone.Channel` → destination. Tone shaping is per source (`setTone`).
- **Song document:**
  - It is defined in Rust (`music::song`), and TS types are generated from it. Unknown fields are tolerated.
  - `validate_track` resolves `instrument` from the registry and dereferences it for rows, sound validation, MIDI export (`song_midi.rs`), and chat and generation context (`context.rs`, `chat.rs`).
  - Shared validation fixtures live in `fixtures/song_validation.json`.
- **Persistence:** songs live in IndexedDB via `idb-keyval` (`songLibrary.ts`). Project files are JSON (`projectFile.ts`, version 1, 5 MiB cap).
- **No audio input or decode exists** yet: no `decodeAudioData`, `getUserMedia`, or `AudioWorklet`.
- **Downstream changes:** `add-audio-recording` (mic takes) and `add-sampler-instrument` (samples played from notes) build on this change's sample model, store, and playback.

## Goals / Non-Goals

**Goals:**
- One sample model and store shared by imports, recordings, and the sampler.
- Sample-accurate clip playback aligned with the step scheduler to within 5 ms.
- Audio bytes never enter the song document, undo stack, chat requests, or the backend.

**Non-Goals:**
- Time-stretching, pitch-shifting, tempo-syncing loops, warping, clip splitting, and crossfades between clips.
- A bundled sample pack, because of licensing.
- Server-side sample storage.

## Decisions

### D1. Reserved instrument id `audio`
- Audio tracks keep the required `instrument` string, set to `"audio"`.
- On the backend, `validate_track` branches before the registry lookup into a new `TrackInstrument::{Instrument(&'static Instrument), Audio}` enum. Consumers then match on it:
  - **MIDI export** skips audio tracks, and doesn't advance the melodic channel counter.
  - **Context building** filters them out.
  - **Generation** rejects an audio target.
- `GET /api/v1/instruments` is unchanged, so the instrument pages and the chat planner never see `audio`.
- *Why:* no version bump, and old builds reject the song (unknown instrument) rather than silently dropping audio.
- *Alternative:* a `kind` field with an optional `instrument`. It was rejected because it touches every `track.instrument` reader in both languages.
- *Spec note:* `songs/multitrack` "Song document" says instruments come from the list. `songs/audio-tracks` adds an explicit exception. At archive, that sentence should mention the reserved id. It is not MODIFIED here, to avoid colliding with `polish-studio-ux`'s block.

### D2. Song-level `samples`, clip positions in ticks, lengths in samples
- `Song.samples: Vec<Sample>` and `Track.audio_clips: Vec<AudioClip>` use `#[serde(default, skip_serializing_if = "Vec::is_empty")]`.
- *Why song-level samples:* a sample can be used on several tracks, and the sampler references samples from instrument tracks too.
- `origin` is an open string enum (`"import"` now). `add-audio-recording` adds `"recording"` plus a `track_id`.
- **Positions:** `start_ticks` uses 240 ticks per sixteenth (960 PPQ). Clips stay on the musical grid across tempo changes, while keeping sub-step precision.
- **Lengths:** `offset_samples`, `slice_samples`, and `length_samples` are in the sample's own frames, so they are exact and independent of tempo.
- **End time:** a clip ends at `ticksToSeconds(start_ticks) + length_samples / sample_rate`. That end feeds `derivedMeasures`, overlap checks, and the 128-measure check.
- **Swing:** it doesn't apply. Ticks map to straight time, and a unit test pins this.
- **Tempo changes:** `setTempo` refuses a tempo that would push audio past measure 128, with code `tempo_limit`.

### D3. Sample ids are content hashes
A sample's `id` is the first 32 hex characters of SHA-256 over its stored PCM bytes plus `sample_rate` and `channels`, computed in a worker at import.
- *Why:* the same file imported twice, or a bundle opened in another browser, maps to the same id. Storage then deduplicates for free, and bundles need no re-id and remap step.
- *Trade-off:* hashing a 200 MB decode takes a second or two in a worker. That is acceptable during import, which already shows progress.

### D4. Decoding and storage
- **Import** goes through `AudioContext.decodeAudioData`, which supports every format the browser does.
- **Sample rate:** `decodeAudioData` resamples to the context rate, so imported samples are stored at that rate (usually 48 kHz). Playback then never resamples.
- **Channels:** more than two channels are downmixed to stereo with equal-power summing.
- **`lib/audio/sampleStore.ts`:** its own `idb-keyval` store (`songbird-samples`). Key `<sampleId>` maps to `{sampleRate, channels, length, data: Blob}`, where the Blob is interleaved little-endian Float32. It is lossless with respect to the decode, and is turned into an `AudioBuffer` without decoding again.
- **`lib/audio/sampleLibrary.ts`:** the library index (`songbird-sample-library`), with entries `{id, name, sampleRate, channels, length, importedAt}`.
- **Waveform overviews** (min/max per 256 frames) are computed in a worker at import and stored alongside, so lanes and the library render without decoding.
- **Space:** `navigator.storage.persist()` is called on the first store, and `estimate()` is checked before each import. A warning appears below 200 MB.

### D5. Reference-counted cleanup
- `collectGarbage()` computes the live set: library ids, plus the `samples` ids of every saved song (read from the song library), plus the open song's history ids. The store keeps a small in-memory set of every sample id seen in the open song's undo and redo stacks.
- It deletes the other stored samples.
- It runs on song open, song delete, and library remove, and is debounced.
- Reading every saved song is acceptable at the current scale (dozens of songs). If it isn't, a per-song sample-id index in the song library index removes the full read.

### D6. Clip playback: a second scheduler path
- On each tick, the engine finds the audio clips whose start falls in `[now, now + lookahead)`, or which are sounding at a start, seek, or loop wrap.
- For each, it starts a pooled `Tone.Player` with `player.start(when, offsetSeconds, durationSeconds)`. Looping clips use `player.loop = true` with `loopStart`/`loopEnd` set to the slice, which gives a gapless, sample-accurate repeat.
- Each player feeds a per-clip `Gain`, which carries the gain plus fade ramps scheduled with `linearRampToValueAtTime`, and then the track's `InsertChain` input.
- Stop, seek, and loop wrap stop active players at the wrap time.
- Buffers come from an `AudioBuffer` cache per sample while any open song or library preview uses it.
- `songPlaybackModel` exposes audio clips per track, and `Voice` gains `kind: "instrument" | "audio"`.
- An offline-render test pins clip onsets to within 1 ms of a note at the same song time.

### D7. Library previews
Previews use one shared `Tone.Player` straight to the destination, so the song mixer doesn't apply. They are separate from the transport, so song playback is untouched.

### D8. Drag and drop
- Library rows use HTML5 drag with a custom MIME type, `application/x-songbird-sample`, carrying the id.
- Lanes and the area below the last lane accept that type and `Files`.
- Drop position comes from the lane's existing pixel-to-tick mapping, with snapping as for clip moves.
- File drops run the import pipeline first, then place the clip in the same undo step. The import itself (storage and library) is not undoable, because it is not song state.

### D9. WAV mixdown
- `renderMixdown(song, onProgress, signal)` renders in 30 s segments with `Tone.Offline`. Each segment overlaps the previous one with 4 s of pre-roll, so delay and reverb tails cross boundaries. `signal` is checked between segments, which provides progress and Cancel.
- Each segment builds the same voices, insert chains, and audio players as live playback, from a snapshot of the song.
- Tails render 4 s past the end, trimmed below −60 dBFS.
- Encoding is 16-bit PCM with TPDF dither, in a worker.
- *Alternative:* one render with no cancel. It was rejected by the spec.

### D10. Project bundles
- `fflate` zips `project.json` plus `audio/<sampleId>.wav` (32-bit float WAV, so any DAW opens it).
- **Import:** unzip streaming, validate `project.json`, check WAV headers against the metadata, store any ids not already present (D3 makes ids stable), add them to the library, then add the song.
- `PROJECT_VERSION` stays 1, because the `project.json` format is unchanged.

### D11. Backend is validation-only
- The backend never receives audio. It needs:
  - the D1 enum and branches;
  - `Sample` and `AudioClip` types with `ts-rs` and `JsonSchema`;
  - validation of references, ranges, overlap at tempo, and the 128-measure limit;
  - `tone` being invalid on audio tracks;
  - the generation target check;
  - skipping audio in MIDI export, context, and chat.
- The 2 MiB song body limit is ample.

## Risks / Trade-offs

- [IndexedDB quota and eviction] → `storage.persist()`, the pre-import space check, and the missing-audio state rather than a crash. Bundles serve as backups.
- [Float32 storage is large, about 23 MB per stereo minute] → It is simple and lossless. FLAC or 16/24-bit storage can come with server storage later.
- [The content-hash cost on huge files] → It runs in a worker, with progress.
- [Decoding resamples to the context rate] → Inaudible for this use. Original-rate storage is possible later if the sampler needs it.
- [Spec exception for the `audio` id until archive] → Called out in D1 and in tasks.
- [Dependency on `add-track-sound-controls`] → Task 1.1 checks that its `InsertChain` wiring has landed.

## Migration Plan

- No data migration. Songs without audio are unchanged.
- Older builds reject songs with audio tracks as an unknown instrument, which is visible and safe.
