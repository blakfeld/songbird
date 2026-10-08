# Proposal

## Why

Songbird's lyric notepad and lyric assistant (`songwriting/lyrics`) help users write words, but the words never reach the music. A songwriter who has a chorus on the page still has to work out by hand how it is sung: where each syllable falls, which notes it lands on, and whether it fits the bars and the singer's range. That step, the topline, is where many writers stall. Songbird already has the pieces needed to help: lyric headings linked to song sections, a song key, cross-track generation context, and a provider stack with a deterministic mock. This change connects them, so the user can pick a lyric section and get a singable vocal melody for it, with each syllable attached to its note.

**Depends on:**
- `songwriting/lyrics` (archived), for lyric headings linked to song sections.
- `songwriting/sections` and `songs/clips` (archived), for section ranges and the loop-and-clip write-back.
- `songs/track-generation` (archived), for the context summarizer, the `applyGeneratedRange` write-back, and the shared generation guarantees.
- **add-section-chord-generation (in progress, soft dependency):** when it has landed, section chords are passed as harmonic context and the mock puts stressed syllables on chord tones. Without it, the melody is fitted to the song key alone. This change does not require chords to exist and does not edit chord code. If both changes are in flight, archive this one after it.

## What Changes

- **Syllables and stress:** each lyric line of a section is split into syllables, and each syllable is marked stressed or unstressed. This is done by a deterministic rule-based syllabifier in the browser. The user can review and correct the splits and stress marks before generating.
- **Topline generation endpoint:** a new `POST /api/v1/songs/topline/generate` takes the song, a target track, the section's measure range, the syllabified lines, a voice range preset, and an optional style prompt. It returns one monophonic vocal line for that range, where every syllable is attached to the note that starts it.
  - The melody is placed so that stressed syllables land on beats, each lyric line becomes a phrase that fits the section's bars, and every pitch lies inside the chosen voice range.
  - It uses the same provider selection, AI access rules, limits, retry, timeout, and cross-track context as track generation. Section chords and the song key are included when present.
  - The mock provider generates a deterministic melody that satisfies the prosody rules, so every path can be tested without a key.
- **Voice range presets:** Soprano, Alto, Tenor, and Baritone, each with a fixed MIDI range.
- **Vocal Guide instrument:** a new melodic instrument, `vocal`, with a range wide enough for every preset, a General MIDI choir-like program, a soft, vowel-like built-in synth voice, and monophonic generation.
- **Lyrics on notes:** a note may carry a `lyric` syllable. The piano roll shows each note's syllable on the note. Moving, resizing, copying, and changing velocity keep it. The note inspector can edit it. A "Re-flow lyrics" action reassigns a topline loop's syllables, in order, to its notes after the user has added or removed notes.
- **Topline source on the loop:** a generated loop remembers the lyric lines, syllables, and voice it was made from. The dock shows when the lyric section has changed since, and offers to regenerate.
- **Studio flow:** a "Generate topline" action on a linked lyric heading and on a section's menu opens a dialog. The dialog shows the section, the syllable preview, the voice, the target track (a new "Vocal" track by default), and an option to place the result on every section with the same name. The result is written as a new loop, placed as a clip over the section, in one undoable step. The lyrics text is never changed.
- **MIDI export:** song MIDI export writes a Lyric meta-event for every note that carries a syllable.

Non-goals:
- Sung or synthesized vocals (singing synthesis). The Vocal Guide is an instrument tone, not a voice.
- Languages other than English for syllabification and stress. Other Latin-script text is still split by the same vowel-group rules, and a word in another script is treated as one syllable.
- Pitch detection or melody extraction from recorded audio.
- Writing lyrics to fit an existing melody (the reverse direction).
- Lyrics on notes in the standalone pattern editor's MIDI download.
- Streaming.

## Capabilities

### New Capabilities
- `songwriting/topline`: syllabification and stress, voice range presets, lyrics on notes in the song document, the topline source on a loop, the generation endpoint with its validation, normalization, prosody rules, and error contract, the deterministic mock, the Studio dialog and write-back, the stale-lyrics notice, and re-flowing syllables.

### Modified Capabilities
- `instruments/melodic`: MODIFIES "Melodic catalog" (adds `vocal`), "Monophonic generation" (adds `vocal`), and "Distinct synth voices" (adds the `vocal` voice).
- `patterns/piano-roll-editor`: ADDS "Lyrics on notes", which covers showing a note's syllable, keeping it through edits, and editing it in the inspector.
- `songs/export`: ADDS "Lyric meta-events in exported MIDI".
- `songwriting/lyrics`: ADDS "Generate a topline from a lyric heading".

## Impact

- **Backend (`music` crate):**
  - `Note` gains an optional `lyric`, and `Loop` gains an optional `topline` source. Both are exported through ts-rs and checked by `Song::validate`.
  - A new `topline` module holds the request validation, the prompt builder (reusing `context::render_context`), the draft schema, the normalizer, and voice presets.
  - A new `ToplineProvider` seam with `SchemaToplineProvider` and `MockToplineProvider`, added to `Providers` in the same way as lyrics.
  - The `vocal` instrument definition, and Lyric meta-events in `song_midi.rs`.
- **Backend (`api` crate):** a new route, `POST /api/v1/songs/topline/generate`, added to `songs::ai_router` so that it is metered, rate limited, and body limited like track generation.
- **Frontend:**
  - `lib/topline/` holds the syllabifier and stress rules, kept in step with `fixtures/syllables.json`, plus the re-flow and lyric-preserving note operations.
  - The topline dialog, the syllable display in `NoteBar`, the lyric field in `NoteInspector`, the stale notice in the dock, entry points in `LyricsEditor` and `SectionMenu`, and a `generateTopline` function in `api.ts`.
  - The `vocal` synth voice.
- **Data:** `Note.lyric` and `Loop.topline` are optional and skipped when empty. Songs and project files saved before this change still load, and the song `version` stays 2.
- **AI cost:** one provider call per topline generation. The context is capped by `max_context_tokens`, as for track generation.
