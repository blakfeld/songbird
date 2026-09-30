# Design

## Context

The frontend is built around a single pattern per instrument:

- `lib/patternStore.ts:44` creates one zustand store per instrument, persisted to localStorage under `songbird.patterns.<instrument>.v1`, with a 100-entry undo history.
- `lib/patternOps.ts` holds pure edit functions over `Pattern`.
- `lib/audio/engine.ts` schedules steps with a lookahead from one `PatternStore` and one `SoundSource`. It re-reads the store on every step so live edits are audible.
- `SoundSource` (`lib/audio/types.ts`) is `load(rows) / trigger(row, start, end, velocity) / stopAll()`. `drumsSource.ts:60` connects each voice straight to `toDestination()`, so the destination is hard-wired and there is no place to insert volume or pan.
- `PianoRoll.tsx` renders `pattern.rows × steps` and is instrument-agnostic.

Changes #1 and #2 add melodic instruments (pitch rows, and a synth `SoundSource` per instrument id).

See proposal.md for motivation and `specs/songs/multitrack/spec.md` for behavior. The backend is untouched.

## Goals / Non-Goals

**Goals:**
- Model the song once, in a shape that #5 can mirror in Rust unchanged, so export and AI requests can take the song as-is.
- Reuse the piano roll, the edit operations, and the timing code, rather than forking them for tracks.
- Keep one scheduler: single-instrument pages and the Studio use the same engine code path.

**Non-Goals:**
- Canvas rendering, and virtualizing lanes beyond 16 tracks.
- Offline rendering or bouncing to audio.
- Syncing a song across browser tabs. The last write wins, and this is documented.
- Showing other tracks as ghost notes in the piano roll. That may come later; the lane overview covers arrangement awareness for now.

## Decisions

### D1. The song type lives in the frontend for now, shaped for Rust
- **Where:** `lib/song/types.ts` defines `Song` and `Track` exactly as the spec's "Song document" requirement describes (snake_case fields, `version: 1`). It reuses the generated `Note` and `TimeSignature` types.
- **Rows:** tracks do not store rows. They come from the instrument listing, so a track cannot drift from its instrument.
- **Handover to #5:** change #5 moves these types into `music` (`song.rs`) with ts-rs, and replaces the hand-written TS with the generated types.
- **Alternatives:**
  - Define it in Rust now. This would create an unused backend type and turn this frontend-only PR into a two-sided one.
  - Store a full `Pattern` per track. This duplicates tempo, meter, and rows per track, and invites them to disagree with the song.

### D2. Generalize the edit operations and the piano roll to take "notes + rows + meter"
- **What changes:** the note-level operations in `patternOps.ts` (`toggleNote`, `setVelocity`, `resizeNote`, and truncation) currently take a `Pattern`. They will instead take a small `NoteGrid { notes, rows, totalSteps }`, with thin `Pattern` wrappers kept so the existing callers and tests stay green.
- **Piano roll:** `PianoRoll` gets a `grid` and callbacks instead of reading the pattern store directly. Both pages then pass their own state.
- **Alternative:** a second `TrackPianoRoll` component. It would duplicate resize, velocity, and scroll logic that has already been tested and debugged.

### D3. One song store per open song, persisted to IndexedDB
- **Store shape:** `lib/song/songStore.ts` is a zustand store holding `song`, `past`, `future`, and `selectedTrackId`.
- **Actions:** actions wrap the pure operations in `lib/song/songOps.ts`. These cover `addTrack`, `deleteTrack`, `renameTrack`, `editTrackNotes`, `setMixer`, `setSongLength` (appending measures, unlike pattern repeat), and `setTempo`/`setSwing`/`rename`.
- **History:** 100 entries, the same as the pattern store.
- **Mixer drags:** a mixer drag calls `beginGesture()` on pointer-down and `setMixer(..., {transient:true})` while moving. The drag commits one history entry on pointer-up.
- **Persistence:** saves go through `idb-keyval`, debounced by 300 ms, under keys `songbird.songs.v1.<id>`. A small index record, `songbird.songs.v1.index` (`[{id,name,updated_at}]`), drives the library list without loading every song.
- **Forward-compatible loading:** the loader keeps fields it does not recognise and writes them back unchanged. Later changes (#7 sections, #8 key and chords, #9 lyrics) add optional fields without bumping `version`, so a song saved by a newer build survives a round trip through an older one.
- **Last opened song:** its id is kept in localStorage (`songbird.studio.lastSong`), which is small and readable synchronously at hydration.
- **Why IndexedDB:** a 16-track, 128-measure song can reach megabytes. localStorage is capped at about 5 MB per origin and is shared with the per-instrument patterns.
- **Alternatives:**
  - zustand `persist` with an IndexedDB adapter. Its all-or-nothing blob makes the library index awkward.
  - Raw IndexedDB. This means more code for no gain over `idb-keyval`'s roughly 600 bytes.

### D4. Engine plays voices, and a voice is a sound source behind a Tone.Channel
- **Refactor:** `createPlaybackEngine` is refactored so it no longer depends on a `PatternStore`. It depends on a `PlaybackModel`:
  - `getTiming()`, which returns `{tempo, swing, stepsPerMeasure, measures}`.
  - `getVoices()`, which returns `[{key, instrument, rows, notes, volumeDb, pan, audible}]`.
- **Adapters:**
  - The single-instrument pages use an adapter over the pattern store that returns one voice.
  - The Studio uses an adapter over the song store.
- **Scheduling:** the scheduler loop is unchanged. At each step it iterates voices instead of one pattern, so live edits and mixer changes are still picked up at step granularity.
- **Routing:** `SoundSourceFactory` gains an optional `output` node: `factory(tone, output?)`. Sources connect to `output ?? destination`.
  - For each voice key, the engine lazily creates one source plus one `Tone.Channel({volume, pan})` routed to the destination.
  - Volume, pan, and audibility (mute and solo resolved in `songOps.audibleTracks`) are applied with `rampTo(…, 0.02)` on each tick. This meets the 50 ms requirement without clicks.
  - Channels for deleted tracks are disposed.
- **Why this design:**
  - One engine keeps timing parity with `fixtures/timing.json` for free.
  - `Tone.Channel` gives equal-power pan and dB volume, which matches the spec's units.
- **Alternative:** one engine per track, all started together. Separate schedulers drift and double the transport bookkeeping.

### D5. Studio page layout
- **Baseline:** `mockups/studio.png`. It is modeled on a familiar DAW arrangement so songwriters coming from one can find their way around without learning a new layout.
- **Page structure:** `app/studio/page.tsx` renders `StudioPage`, a three-region grid:
  - **Arrangement (top left):** the song header (name, tempo, swing, length, library menu) and transport sit above the track list. Each `TrackLane` pairs a `TrackHeader` with a timeline area under a shared measure ruler. The header shows the track number, instrument icon, name, Mute, Solo, a volume slider, and a pan knob. It holds the mixer so balancing never needs a separate mixer view. The Add Track control sits at the top of the header column.
  - **Editor dock (bottom left):** a header with the selected track's name and instrument, a bar.beat ruler, and that track's `PianoRoll`. The split between arrangement and dock is fixed in this change, because resizing adds persistence and drag handling that nothing yet needs.
  - **Assistant column (right, full height):** `AssistantPanel`, with chat history above and a chat input below. In this change it shows an empty state and a disabled input. It is laid out now so that #6's global chat and #10's lyric assistant fill a column that already exists, instead of reworking the grid.
- **Playhead:** it spans both the lanes and the dock, so the user can see where playback is in the arrangement and in the note being edited.
- **Note overview:** `NoteOverview` draws the track's notes in miniature, as one region-style block spanning the song and a single SVG path per lane. The mockup relies on seeing the shape of each part at a glance. One path per lane stays cheap at 16 × 128 measures without canvas or virtualization.
- **Time signature:** the new-song dialog asks for the time signature. After creation it is shown read-only.
- **Before building:** `ui-designer` turns the mockup into a layout spec before implementation (task 4.1). `ui-spec.md` records only the places it departs from the mockup and why.
- **Deliberately omitted from the mockup:** the editor tabs other than Piano Roll, the quantize/scale/velocity inspector, the R/I buttons, and folder tracks (see proposal non-goals).

### D6. Send to song
- **UI:** `SendToSongButton` sits in `EditorToolbar`.
- **Behavior:** it opens a dialog listing songs from the index whose time signature matches (read from the index record, which also stores `time_signature`), plus a "New song" option.
- **Operation:** it runs `songOps.addTrackFromPattern` on the loaded song and saves. It then offers a link to `/studio?song=<id>`.

## Risks / Trade-offs

- [The engine refactor could regress drum-machine playback] → The existing `engine.test.ts` suite must pass unchanged against the single-voice adapter before any Studio code is written (task 2.3).
- [IndexedDB is async, so hydration flashes an empty page] → Render a loading state until the song loads, reusing the `Hydration` pattern already tested in `Hydration.test.tsx`.
- [Many simultaneous synth voices across 16 tracks may crackle on slow machines] → Cap polyphony per synth source, as #2 defines. Measure a 16-track, 32-measure demo song manually (task 6.3) and record the result.
- [Two tabs editing the same song overwrite each other] → Accepted for this change and noted in the README. The library index stores `updated_at`, so a later change can detect conflicts.
- [Very long songs (128 measures) make the piano roll wide] → Horizontal scrolling already exists, and the lanes share the same scroll position.

## Migration Plan

Additive. Existing per-instrument localStorage patterns are untouched. Rollback removes the route and the IndexedDB keys stay unused.
