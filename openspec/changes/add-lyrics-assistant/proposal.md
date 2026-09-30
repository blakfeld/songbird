# Proposal

## Why

Songbird can arrange a song's music (tracks, sections, chords), but songwriters still have nowhere to write the words. Lyrics are written against the song's structure and harmony, so an AI co-writer that already knows the sections, the section notes, and the chords can give much better help than a generic chat window. This is the last piece of the songwriting tools feature (feature 3).

**Depends on:** #7 `add-song-sections`, which provides sections and section notes. It also builds on #4 `add-multitrack-song` (the song document and `/studio` page) and #5 `add-song-export` (the Rust `Song` type, the project-file validator, and the 1 MiB body limit for `/api/v1/lyrics/`) and uses chords from #8 `add-section-chord-generation` when they are present. It does not need #8 to have landed. It extends the `Providers` bundle that #8 introduces, or introduces it in the same shape if #8 has not landed. This is PR 9 of 10 in the Songbird roadmap. #10 `add-lyrics-vim-mode` builds on it.

## What Changes

- **Lyric notepad**: every song gets one lyric notepad. It is a plain-text editor on the `/studio` page, saved with the song in the browser and included in the song project file.
  - A line that holds only `[Name]` (for example `[Chorus]`) starts a lyric section. It is linked to the song section of the same name.
  - An "Add section headings" action writes a heading for each song section that has none yet.
- **AI lyric assistant**: a chat panel beside the notepad.
  - Each request sends the conversation so far, the current lyrics, the user's text selection, and a compact summary of the song: name, key, tempo, and each section's name, kind, length, notes and chords.
  - The assistant replies with prose and, optionally, up to five suggestions. Each suggestion can be inserted at the cursor, replace the selection, or replace one lyric section.
  - Nothing changes the lyrics until the user clicks a suggestion's action. Applying a suggestion is a single undoable edit.
  - The conversation is kept with the song, and the user can clear it.
- **New endpoint** `POST /api/v1/lyrics/assist`: a stateless multi-turn request, where the client holds the history. It returns `{reply, suggestions}`.
  - It uses the same provider selection, validation-before-provider, output normalization, one retry, timeout, and error shape as pattern generation.
  - The mock provider answers deterministically and makes no network calls.
- **Bounded input**:
  - Each user message is limited by the existing `max_input_tokens` estimate.
  - History is limited to 20 messages.
  - Lyrics are limited to 20,000 characters.
  - Section notes are limited to 5,000 characters each, matching #7.
  - Replies and suggestions are capped.
  - Because every input is bounded, there is no new configuration setting.
- **Editor foundation**: the notepad uses CodeMirror 6, so #10 can add vim bindings as an editor extension instead of replacing the editor.

## Capabilities

### New Capabilities
- `songwriting/lyrics`: The song's lyric notepad (content, section headings, persistence, limits) and the AI lyric assistant (chat panel, suggestion application, and the `POST /api/v1/lyrics/assist` contract, validation, and error behavior).

### Modified Capabilities
<!-- None. The 1 MiB body limit for routes under /api/v1/lyrics/ is introduced by #5 add-song-export in platform/service-operations. Lyrics and chat history are new optional fields on the song document that #4 and #5 define. Older songs and project files without them load with empty lyrics and no conversation, so no existing requirement changes. -->

## Impact

- **Backend**:
  - New `music::lyrics` module (request validation, prompt, schema, and the normalization of suggestions).
  - A `LyricsProvider` seam implemented by `SchemaProvider<T>` and `MockProvider`.
  - A new `api/src/lyrics.rs` router.
  - `AppState` carries the lyrics provider.
  - New ts-rs types go through `just gen-types`.
- **Frontend**:
  - New `components/lyrics/` (notepad, chat panel, suggestion cards) and `lib/lyrics/` (section-heading parsing, suggestion application).
  - The song document gains `lyrics` and `lyric_chat`.
  - The `/studio` page gets a Lyrics panel.
- **New dependencies**: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands` (MIT). They are loaded on the client only.
- **API**: `POST /api/v1/lyrics/assist`.
- **Cost**: each chat turn is one provider call. The bounded input keeps a single call to about 10k tokens at worst.
- **Non-goals**:
  - Streaming replies.
  - Server-side storage of lyrics or conversations.
  - Rhyme or syllable-count tooling outside the AI.
  - Inline selection actions without chat. The user chose a chat panel with suggestions to apply.
  - Singing or melody generation from lyrics.
  - Vim bindings, which are #10.
  - More than one notepad per song.
