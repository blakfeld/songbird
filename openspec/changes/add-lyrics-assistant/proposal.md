# Proposal

## Why

Songwriters can now write lyrics in the Studio's notepad, but the only AI help on the page is the song chat, which arranges tracks and knows nothing about words. Lyrics are written against the song's structure and harmony, so a co-writer that already knows the sections, the section notes, and the chords can give much better help than a generic chat window. This is the last piece of the songwriting tools feature (feature 3).

**Depends on** (all archived):
- `2026-10-02-add-lyric-notepad`: the CodeMirror notepad, the `lyrics` field on Song with its 20,000-character limit, the Lyrics tab and drawer, heading styling, separate notepad undo, and shortcut isolation (`openspec/specs/songwriting/lyrics/spec.md`).
- `2026-10-02-add-song-sections`: sections with names, kinds, lengths and 5,000-character notes, including implicit "Song", "Song 2", … chunks for unsectioned songs (`openspec/specs/songwriting/sections/spec.md`).
- The song chat, per-user AI keys, and AI usage limits that the existing AI endpoints already go through.

It uses chords from #8 `add-section-chord-generation` when they are present, and sends an empty chord list otherwise, so it does not need #8 to have landed. #10 `add-lyrics-vim-mode` builds on it. This is PR 9 of 10 in the Songbird roadmap.

## What Changes

- **Heading linking**: a notepad heading such as `[Chorus]` is linked to the song section of the same name, ignoring case and surrounding whitespace. Headings with no matching section are marked as unlinked.
  - An "Add section headings" action appends a heading for each section that has none yet.
  - Unsectioned songs link to their implicit sections ("Song", "Song 2", …), which keep their names when they become real sections.
- **AI lyric assistant**: a chat panel in the Lyrics tab, below the notepad.
  - Each request sends the conversation so far, the current lyrics, the user's text selection, and a compact summary of the song: name, key, tempo, meter, and each section's name, kind, length, notes and chords.
  - The assistant replies with prose and, optionally, up to five suggestions. Each suggestion can be inserted at the cursor, replace the selection, or replace one lyric section.
  - Nothing changes the lyrics until the user clicks a suggestion's action. Applying a suggestion is a single notepad undo step.
  - The conversation is saved with the song, separately from the song chat, and the user can clear it.
- **New endpoint** `POST /api/v1/lyrics/assist`: a stateless multi-turn request, where the client holds the history. It returns `{reply, suggestions}`.
  - It goes through the same sign-in, per-user API key resolution, rate and daily usage limits, concurrency limit, timeout, one retry, and error mapping as the existing AI endpoints.
  - The mock provider answers deterministically and makes no network calls.
- **Bounded input**:
  - The latest user message is limited by the existing `max_input_tokens` setting.
  - History is limited to 20 messages of at most 4,000 characters each, as in the song chat.
  - Lyrics and section notes keep their existing limits (20,000 and 5,000 characters).
  - The conversation and section notes sent to the model are trimmed to the existing `max_context_tokens` budget.
  - Replies and suggestions are capped.
  - There is no new configuration setting.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `songwriting/lyrics`:
  - "Lyric headings" gains linking to song sections, the unlinked marker, and the "Add section headings" action.
  - New requirements cover the lyric assistant: the chat panel, conversation persistence, applying suggestions, the `POST /api/v1/lyrics/assist` contract, its input validation and output normalization, treating user text as data, and the deterministic mock.

## Impact

- **Backend**:
  - New `music::lyrics` module, modeled on `music::chat`: request types and validation, prompt rendering, normalization, and the retry loop.
  - New `music::ai::lyrics` module, modeled on `music::ai::plan`: the `LyricsProvider` trait, the `SchemaLyricsProvider<T>` adapter, and `MockLyricsProvider`.
  - `Providers` (`api/src/provider.rs`) gains a `lyrics` field. Every access mode fills it, including per-user keys and the user-mock failures.
  - New `api/src/lyrics.rs` handler, merged into the metered AI routes with the 2 MiB song body limit.
  - `Song` gains an optional `lyric_chat` field, validated like `chat`.
  - New ts-rs types go through `just gen-types`.
- **Frontend**:
  - `lib/lyrics/` gains section linking, "Add section headings", suggestion application, and the song-context builder, all reusing `headings.ts`.
  - `components/lyrics/` gains the chat panel and suggestion cards. `LyricsEditor` exposes a handle for reading the selection and applying changes, and marks unlinked headings.
  - The song store gains lyric-chat actions that stay out of song undo, like the song chat.
  - `lib/api.ts` gains `assistLyrics`.
- **API**: `POST /api/v1/lyrics/assist`.
- **Dependencies**: none new. The CodeMirror packages are already installed.
- **Cost**: each chat turn is one provider call, counted against the user's existing per-minute and daily AI limits.
- **Non-goals**:
  - Streaming replies.
  - Server-side conversation memory. The server stores the conversation only as part of the saved song.
  - Rhyme or syllable-count tooling outside the AI.
  - Inline selection actions without chat. The user chose a chat panel with suggestions to apply.
  - Singing or melody generation from lyrics.
  - Giving the song chat access to lyrics, or the lyric assistant access to tracks.
  - Vim bindings, which are #10.
