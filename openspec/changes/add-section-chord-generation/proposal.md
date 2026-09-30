# Proposal

## Why

Harmony is where many songwriters get stuck. They know the chorus should "lift" and the bridge should "feel unresolved," but they don't know which chords do that. With sections in place (#7), Songbird can take a plain-language prompt and write a chord progression for each section that fits the song's key and the sections around it.

Chords are also what keeps multiple tracks musically coherent. When track generation (#6) is told which chords are sounding, the bass, keys, and lead parts it generates agree harmonically instead of merely coexisting.

**Depends on:**
- #7 add-song-sections, for the sections that chords attach to.
- #6 add-context-aware-track-generation, for the `songs/track-generation` capability that this change extends with chord context.

Archive this change after both.

## What Changes

- **Song key**: a song gains an optional key such as `C major` or `F# minor`. It is set by the user or chosen by the AI on the first chord generation.
- **Chord progressions per section**: each section can hold a chord progression. The chords tile the section on beat boundaries and use a defined chord-symbol grammar, such as `C`, `Am7`, `F/A`, `Bm7b5`, or `Gsus4`.
- **Chord generation**: a new endpoint, `POST /api/v1/songs/chords/generate`, writes progressions for one or more chosen sections from a prompt.
  - It is aware of the song's key, each section's kind and notes, and the chords already in the other sections.
  - Output goes through the same provider, validation, normalization, retry, and timeout rules as pattern generation.
- **Chord lane**: a lane aligned with the song timeline shows each chord's symbol. The user can:
  - change a chord's symbol (validated against the grammar);
  - split a chord at a beat;
  - delete a chord;
  - move the boundary between two adjacent chords.
  
  All of these edits can be undone.
- **Chords follow section edits**: when a section is resized, duplicated, or deleted (#7), its chords are shortened, extended, copied, or removed along with it.
- **Render chords to a track**: this writes deterministic block voicings of the chords in a chosen range into a chosen melodic track. Bass-range instruments get root or slash-bass notes only. The action replaces that track's notes in the range and can be undone.
- **Chord-aware track generation**: when the generation range contains chords, the song key and those chords are included in the track-generation request as harmonic context. The mock provider draws melodic notes from the sounding chord, so the behavior is testable.

Non-goals:
- Chord playback without a track, or auditioning a chord on click.
- Roman-numeral display.
- Automatic key detection from existing notes.
- Chord symbols in MIDI export.
- Streaming.
- Server-side storage.

## Capabilities

### New Capabilities
- `songwriting/chords`: This covers the song key, per-section chord progressions, and the chord-symbol grammar. It also covers the chord generation endpoint and its validation, normalization, and error contract; the chord lane and editing; how chords follow section edits; rendering chords to a track; and persistence.

### Modified Capabilities
- `songs/track-generation` (introduced by #6, and not yet in `openspec/specs/`): this change ADDS the requirement "Chord context for track generation". It does not modify #6's existing requirements.

## Impact

- **Backend (`music` crate)**:
  - New chord module: symbol parser, normalizer, and draft schema.
  - New chord prompt, mock chord progressions, and a chord provider seam.
  - `key` and `sections[].chords` added to the Rust `Song` mirror, exported through ts-rs.
  - The track-generation prompt builder and mock gain chord context.
- **Backend (`api` crate)**: a new route, `POST /api/v1/songs/chords/generate`. It is under `/api/v1/songs/`, so the 1 MiB body limit from #5 applies. `AppState` gains the chord provider.
- **Frontend**:
  - A chord parser in TypeScript, kept in sync with Rust through a shared fixture `fixtures/chords.json`.
  - Song store actions for key, chords, and render-to-track.
  - The chord lane, the generate-chords dialog, and the key selector.
- **Data**: `Song.key` and `Section.chords` are optional. Songs and project files from #4, #5, and #7 still load, and the song `version` stays 1.
- **AI cost**: one provider call per chord generation. The prompt is capped at 256 tokens as today. Song context is capped by `SONGBIRD_MAX_CONTEXT_TOKENS` from #6.
