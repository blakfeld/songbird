# Proposal

## Why

Songbird edits one instrument at a time, and each instrument page keeps its own separate pattern. A song needs several parts heard together: drums, bass, chords, and a lead. Today a songwriter cannot hear whether a bass line works against the drums without exporting both and lining them up in a DAW. With melodic instruments arriving in changes #1–#3, this change adds the missing container, a multitrack song, that the later songwriting tools (#5–#10) build on.

## What Changes

- A new **Studio** page at `/studio` for songs. A song has a name, tempo, time signature, swing, and a length of 1–128 measures, and holds 1–16 tracks.
- **Tracks**: each track has exactly one instrument from `GET /api/v1/instruments`. The same instrument may be used on several tracks. Tracks can be added, renamed, and deleted.
- **Per-track editing**: selecting a track opens it in the existing piano-roll editor, with that instrument's rows and the same add, remove, velocity, and resize behavior. Every track lane shows a compact overview of its notes so the whole arrangement is visible at once.
- **Studio layout** follows `mockups/studio.png`:
  - The top-left arrangement holds track headers (number, instrument icon, name, Mute, Solo, volume slider, pan knob) beside timeline lanes, under a measure ruler.
  - Below it, an editor dock shows the selected track's piano roll.
  - A full-height assistant column on the right has chat history above and a chat input below. This change lays the column out but leaves it inactive. #6 turns it into the global chat that generates tracks.
- **Mixer**: each track has volume (−60 to +6 dB), pan (full left to full right), mute, and solo. These apply to playback immediately.
- **Mixed playback**: Play, Stop, Space, the loop range, and the playhead from `patterns/playback` now cover the whole song, with every audible track mixed together.
- **Song library in the browser**: songs are stored only in the browser. The user can create, open, rename, duplicate, and delete songs, and changes are saved automatically. Undo and redo cover note edits, track changes, and mixer gestures.
- **Send to song**: the single-instrument editors (`/drum-machine`, `/instruments/[id]`) can copy their current pattern into a new track of a new or existing song.
- **Non-goals**:
  - Live MIDI or audio recording.
  - Server-side storage or accounts.
  - Multitrack export (#5).
  - AI generation of tracks (#6).
  - Sections (#7).
  - Changing a song's time signature after it is created.
  - Reordering tracks.
  - Chat behavior in the assistant column (#6, and #10 for lyrics).
  - Parts of the mockup beyond the piano roll: the Score, Step Sequencer, and Session Player editor tabs; the quantize, scale, and velocity inspector; the record-arm and input-monitor (R/I) buttons; track folders or stacks; and editing regions as clips.

Depends on: #2 `add-melodic-piano-roll`, which provides the piano-keyboard rows and synth sound sources for melodic tracks. #3 `add-synth-instrument-set` is optional: tracks can use any instrument listed at the time.

## Capabilities

### New Capabilities
- `songs/multitrack`: The song document, tracks with one instrument each, per-track editing, the mixer (volume, pan, mute, solo), mixed playback, the browser song library, and undo/redo on the Studio page.

### Modified Capabilities
- `patterns/piano-roll-editor`: Adds a "Send to song" action to the single-instrument editor pages. Existing requirements are unchanged.

## Impact

- **Frontend only.** No API or backend changes:
  - New `app/studio/` route.
  - A song store, replacing the per-instrument pattern store on this page.
  - A song-aware playback path in `lib/audio/engine.ts` that plays several sound sources, each routed through a per-track channel for volume and pan.
  - Track header, mixer, and note-overview components, plus an inactive `AssistantPanel` shell.
- **Storage:** songs go in IndexedDB rather than localStorage, because song bodies can exceed localStorage quotas. This adds one small dependency, `idb-keyval`.
- **Playback engine:** it is generalized from "one instrument's pattern store" to "a set of voices with shared timing". The existing single-instrument pages keep their behavior and tests.
- **Landing page:** gains a Studio entry.
