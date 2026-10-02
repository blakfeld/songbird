# Proposal

## Why

Songbird can build a song's arrangement, but there is nowhere to write its words, so songwriters keep lyrics in a separate app and lose them when they switch songs or machines. The lyric notepad was planned as part of #9 `add-lyrics-assistant`, which also depends on song sections (#7) and a new AI endpoint. Splitting the notepad out lets it ship now, with no dependency on sections or AI. The assistant and vim mode can then build on it later.

## What Changes

- **Lyric notepad**: every song gets one plain-text lyrics field, edited in a Lyrics panel on the `/studio` page.
  - On wide screens the panel shares the Studio's right column with the existing assistant chat, and the user switches between them with tabs. On narrow screens it opens in the same drawer the assistant uses.
  - A line that holds only a bracketed name, such as `[Chorus]`, is shown as a heading so the lyric's structure is easy to scan. Headings are only styling for now. Linking them to song sections stays in #9.
- **Saved with the song**: lyrics are an optional field of the song document. They autosave with the song to the user's projects on the server, appear in "Download project" files, and load from "Open project" files.
  - Songs and project files without lyrics load with an empty notepad.
  - A song with empty lyrics serializes exactly as it does today.
- **Length limit**: lyrics hold at most 20,000 characters.
  - The notepad refuses input that would pass the limit and shows a character count once the lyrics pass 18,000.
  - The server and the project-file validator reject longer lyrics with the existing `invalid_song` error.
- **Undo kept separate**: the notepad has its own text undo. Song undo/redo (track, note, and setting edits) never changes lyrics, and the notepad's undo never changes the arrangement.
- **Shortcut isolation**: while the notepad has focus, typing never triggers Studio shortcuts such as Space for play or `r` for record.
- **Editor foundation**: the notepad uses CodeMirror 6, so #9's suggestion actions and #10's vim bindings become editor extensions rather than a replacement editor.

Non-goals:
- Linking headings to song sections, or an "Add section headings" action (stays in #9, after #7).
- AI lyric help of any kind (stays in #9).
- Vim bindings (#10).
- Rich text, rhyme or syllable tools, and lyrics in MIDI or WAV export.
- Merging concurrent edits of the same song from two tabs. The existing revision-conflict handling applies unchanged.

## Capabilities

### New Capabilities
- `songwriting/lyrics`: The song's lyric notepad. It covers the Lyrics panel, heading display, persistence with the song and in project files, the length limit and its validation, undo separation, and shortcut isolation. It uses the path #7 and #9 already planned (`songwriting/`), so #9 and #10 can modify this capability instead of creating it.

### Modified Capabilities
<!-- None. Lyrics are a new optional field of the song document. The existing project-storage and project-file requirements already store a valid song as given and validate it with the song rules. This change adds the lyrics rule to those song rules inside songwriting/lyrics, so no existing requirement text changes. -->

## Impact

- **Backend** (`music` crate): an optional `lyrics` field on the Rust `Song` (`backend/crates/music/src/song.rs`), a 20,000-character rule in `Song::validate`, regenerated TypeScript types, and new cases in `fixtures/song_validation.json`. There is no database migration, because the song is stored as a JSON blob. There are no new routes, and the existing 2 MiB song body limit is enough.
- **Frontend**:
  - The song store gets a lyrics setter that is not an undo step and survives undo/redo, following the `chat` precedent.
  - `lib/song/projectFile.ts` gets validation for the new field.
  - There is a new `components/lyrics/` notepad and a tabbed right column in `StudioPage.tsx`.
- **New dependencies**: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands` (MIT). They are loaded only when the Lyrics panel opens.
- **Other planned changes**: #9 `add-lyrics-assistant` must be narrowed to the AI assistant and changed to modify `songwriting/lyrics`, and depend on this change. Its old line "No lyrics SHALL be sent to the server for storage" no longer holds now that songs are stored on the server. #10 `add-lyrics-vim-mode` should depend on this change for the editor.
