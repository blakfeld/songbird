# Proposal

## Why

Generation today produces a standalone pattern for one instrument and knows nothing about the rest of the song. A generated bass line cannot lock to the kick drum, and generated keys cannot follow the bass's harmony. Songwriters want to generate or regenerate one track at a time while the AI listens to everything else, so the arrangement stays musically coherent.

## What Changes

- A new endpoint, `POST /api/v1/songs/tracks/generate`, accepts `{song, track_id, prompt, range?}`. It returns a new part for one track over a measure range, either the whole song or 1–32 chosen measures. The part's notes are positioned from the start of the range, ready to become a loop.
- **Other tracks as context:**
  - Every other unmuted track's notes, in and around the range, go to the AI as a compact musical summary. "Notes" here always means the notes a track's clips actually play: loops and clips (add-arrangement-clips) are flattened with the same algorithm as playback and export (#5's `resolve_track_notes`).
  - For melodic tracks, the summary gives the pitches sounding on each beat and the bass note.
  - For drums tracks, it gives the onset grid.
  - The target track's own notes just before and after the range are included too, so the new part joins up with its surroundings.
  - A configurable context token budget (`SONGBIRD_MAX_CONTEXT_TOKENS`, default 4000) bounds cost. When the context would exceed the budget, the measures farthest from the range are dropped first.
- **The song's settings are respected.** Tempo, time signature, and swing come from the song and are never changed by the AI. Notes are validated and normalized with the same rules as pattern generation: the same providers, retry, 60-second timeout, and error codes.
- A new endpoint, `GET /api/v1/songs/limits`, publishes `max_input_tokens`, `max_range_measures` (32), `max_song_measures` (128), and `max_tracks` (16).
- **Studio UI:** each track gets a Generate action with a prompt, a token counter, and a range choice (whole song, loop range, or a custom measure span). "Loop range" uses the song's loop region (add-timeline-loop-region) and is offered only while looping is on and the region covers less than the whole song.
  - While a generation runs, the target track is locked and other tracks stay editable.
  - The result becomes a **new loop** on the track, placed as **one clip** covering the range, as one undoable step. Clips inside the range are removed, and clips crossing a range edge are split so that everything outside the range keeps playing exactly as before. No existing loop's contents are changed, so other clips linked to those loops are unaffected.
- **Global song chat:** the Studio's right-hand assistant column (laid out by #4) becomes one chat for the whole song, and it is the main way to build an arrangement.
  - "Give me a piano that does …" adds a new track. The AI picks a fitting instrument and generates its part, which the track holds as one loop placed as one clip.
  - Follow-ups such as "give me the drums to match" and "now the bass" each add one more track. Each uses the conversation and every other track as context, so the parts are written to fit together.
  - Each chat-added track is one undo step. The per-track Generate action remains for regenerating a range of an existing track.
  - A new stateless endpoint, `POST /api/v1/songs/chat`, takes the song and the recent conversation. It makes two AI calls. A small planner call chooses the instrument and rewrites the request into a self-contained prompt. The track generation above then writes the part.
  - Questions that do not ask for a part get a text reply only.
  - The conversation, up to its latest 20 messages, is saved with the song.
- **Non-goals:**
  - Generating several tracks in one request, or one chat message.
  - The chat editing, regenerating, or deleting existing tracks.
  - Streaming.
  - Chord context. #8 adds that as a separate requirement.
  - Server-side memory of past generations.

Depends on: #4 `add-multitrack-song` (including its `AssistantPanel` shell), `add-arrangement-clips` (loops, clips, and the browser's clip operations), #5 `add-song-export` (for the Rust `Song` type with loops and clips, `Song::validate`, the resolved notes on `ValidSong`, and the 1 MiB body limit on `/api/v1/songs/`), and `add-timeline-loop-region` (the song's `loop_region` and its on/off state, which decide when a loop range is offered).

## Capabilities

### New Capabilities
- `songs/track-generation`: Generating one track of a song over a measure range, with the other tracks as context. It also covers the global song chat that adds generated tracks from plain-language requests. This covers the endpoint contract, validation, the context summary and budget, song limits discovery, and the Studio generate flow.

### Modified Capabilities
- `platform/service-operations`: "Environment-based configuration" adds the context token budget setting.

## Impact

- **Backend (`music`):**
  - A plan provider kind (`ai/plan.rs`) and the `Providers { patterns, plans }` bundle. This change introduces the bundle in the shape #8 planned, and #8 then adds `chords` to it.
  - Transcript and arrangement-summary rendering for the planner.
  - A generation span that accepts any length of 1–32 measures, rather than only the `MeasureCount` values.
  - A new `context.rs` for the summary and budget.
  - A prompt section for context, fence-escaped because track names are user text.
  - A generation function for songs.
  - Context-aware mock drafts.
- **Backend (`api`):**
  - New routes in `songs.rs`: track generate, chat, and limits.
  - `SONGBIRD_MAX_CONTEXT_TOKENS` in `config.rs`.
  - A new validation error code `invalid_track`, alongside `invalid_range`.
- **Frontend:**
  - A Studio `TrackGenerateDialog`.
  - The chat behavior of `AssistantPanel`, the shell #4 provides.
  - `generateTrack`, `sendChat`, and `getSongLimits` in `lib/api.ts`.
  - An optional `chat` field on the song document, saved under #5's optional-field policy.
  - A song store action that writes a generated part as a new loop and clip over the range, using new `splitClip` and `clearMeasureRange` helpers in `lib/song/clipOps.ts` (shared with #7, whichever lands first adds them).
- `.env.example` and `backend/README.md` document the new setting.
- **Compatibility:** `POST /api/v1/patterns/generate` behavior is unchanged.
