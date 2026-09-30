# Proposal

## Why

Generation today produces a standalone pattern for one instrument and knows nothing about the rest of the song. A generated bass line cannot lock to the kick drum, and generated keys cannot follow the bass's harmony. Songwriters want to generate or regenerate one track at a time while the AI listens to everything else, so the arrangement stays musically coherent.

## What Changes

- A new endpoint, `POST /api/v1/songs/tracks/generate`, accepts `{song, track_id, prompt, range?}`. It returns replacement notes for one track over a measure range, either the whole song or 1–32 chosen measures.
- **Other tracks as context:**
  - Every other unmuted track's notes, in and around the range, go to the AI as a compact musical summary.
  - For melodic tracks, the summary gives the pitches sounding on each beat and the bass note.
  - For drums tracks, it gives the onset grid.
  - The target track's own notes just before and after the range are included too, so the new part joins up with its surroundings.
  - A configurable context token budget (`SONGBIRD_MAX_CONTEXT_TOKENS`, default 4000) bounds cost. When the context would exceed the budget, the measures farthest from the range are dropped first.
- **The song's settings are respected.** Tempo, time signature, and swing come from the song and are never changed by the AI. Notes are validated and normalized with the same rules as pattern generation: the same providers, retry, 60-second timeout, and error codes.
- A new endpoint, `GET /api/v1/songs/limits`, publishes `max_input_tokens`, `max_range_measures` (32), `max_song_measures` (128), and `max_tracks` (16).
- **Studio UI:** each track gets a Generate action with a prompt, a token counter, and a range choice (whole song, loop range, or a custom measure span).
  - While a generation runs, the target track is locked and other tracks stay editable.
  - The result replaces the track's notes in the range as one undoable step.
- **Non-goals:**
  - Generating several tracks in one request.
  - Streaming.
  - Chord context. #8 adds that as a separate requirement.
  - Server-side memory of past generations.

Depends on: #4 `add-multitrack-song` and #5 `add-song-export` (for the Rust `Song` type, `Song::validate`, and the 1 MiB body limit on `/api/v1/songs/`).

## Capabilities

### New Capabilities
- `songs/track-generation`: Generating one track of a song over a measure range, with the other tracks as context. This covers the endpoint contract, validation, the context summary and budget, song limits discovery, and the Studio generate flow.

### Modified Capabilities
- `platform/service-operations`: "Environment-based configuration" adds the context token budget setting.

## Impact

- **Backend (`music`):**
  - A generation span that accepts any length of 1–32 measures, rather than only the `MeasureCount` values.
  - A new `context.rs` for the summary and budget.
  - A prompt section for context, fence-escaped because track names are user text.
  - A generation function for songs.
  - Context-aware mock drafts.
- **Backend (`api`):**
  - New routes in `songs.rs`.
  - `SONGBIRD_MAX_CONTEXT_TOKENS` in `config.rs`.
  - A new validation error code `invalid_track`, alongside `invalid_range`.
- **Frontend:**
  - A Studio `TrackGenerateDialog`.
  - `generateTrack` and `getSongLimits` in `lib/api.ts`.
  - A song store action that applies range replacements.
- `.env.example` and `backend/README.md` document the new setting.
- **Compatibility:** `POST /api/v1/patterns/generate` behavior is unchanged.
