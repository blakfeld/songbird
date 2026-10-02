# Tasks

## 1. Song document field and validation

- [x] 1.1 Add `lyrics: String` to the Rust `Song` in `backend/crates/music/src/song.rs` with `#[serde(default, skip_serializing_if = "String::is_empty")]` and `#[ts(as = "Option<String>", optional)]` (design D1). Add `MAX_LYRICS_CHARS = 20_000`, `SongErrorKind::Lyrics`, and a `chars().count()` check in `Song::validate`. Verify with unit tests: 20,000 multi-byte characters pass, 20,001 characters fail with the lyrics kind, and a song without lyrics serializes byte-identically to before.
- [x] 1.2 Add `lyrics` cases (empty, exactly 20,000 multi-byte, and 20,001 characters) to `fixtures/song_validation.json`. Verify that the Rust fixture test in `song.rs` passes.
- [x] 1.3 Add a `backend/crates/api/tests/projects.rs` test that a `PUT` with 20,001-character lyrics returns `422 invalid_song` and leaves the stored revision unchanged, and that a song with lyrics round-trips through `POST` then `GET`. Verify that `cargo test -p api --test projects` passes.
- [x] 1.4 Run `just gen-types` and commit the regenerated `frontend/src/generated/Song.ts`. Verify `cargo test -p music --test ts_bindings` passes.
- [x] 1.5 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify both pass with no warnings.
- [x] 1.6 Mirror the limit in the browser. Add `LYRICS_MAX_CHARS` to `lib/song/types.ts`, a `"lyrics"` `ProjectErrorKind`, and a `charLength` check in `lib/song/projectFile.ts` with a message naming the 20,000-character limit. Verify that `projectFile.test.ts` and `migrate.test.ts` pass, including the new fixture cases.

## 2. Song store

- [x] 2.1 Add `setLyrics(text)` to `lib/song/songStore.ts` as a non-history `set`. Generalize `withLiveChat` into a helper that carries both `chat` and `lyrics`, and use it at every undo, redo, and `cancelGesture` site (design D2). Verify with Vitest: `setLyrics` adds no undo step; undoing a track add after a lyrics edit keeps the lyrics; redo keeps them too; a cancelled gesture keeps them; and the autosave subscriber saves after `setLyrics`.
- [x] 2.2 Add `lib/lyrics/headings.ts` with `isHeadingLine` and `headingLines` (design D5). Verify with Vitest: `[Chorus]` and `  [Verse 1]  ` are headings, while `I said [softly] goodbye`, `[]`, and `[a]b` are not.

## 3. Notepad UI

- [x] 3.1 Ask `ui-designer` for the right-column tab bar, the narrow-screen "Lyrics" button placement, the heading style, the limit notice, and the counter (design D4). Verify that the resulting spec notes are recorded in the PR description.
- [x] 3.2 Add `@codemirror/state`, `@codemirror/view`, and `@codemirror/commands` to `frontend/package.json`. Create `components/lyrics/LyricsEditor.tsx` (client-only via `next/dynamic`), with the D3 extensions: history and keymap without Tab capture, line wrapping, `aria-label="Lyrics"`, a placeholder, a heading decoration, and a 20,000-code-point change filter with a notice and a counter above 18,000. Add debounced store sync with flush on blur, unmount, and `visibilitychange`, and reset state when `song.id` changes. Verify with Vitest (jsdom): typing updates the store after the debounce; a paste past the limit is refused and leaves the text unchanged; the counter appears at 18,001; switching songs shows the other song's lyrics; and `pnpm build` succeeds with no SSR error.
- [x] 3.3 Add the "Assistant" / "Lyrics" tabs to the Studio right column at `lg` and up, persisted under `songbird.studio.rightTab` with try/catch, and a "Lyrics" drawer button below `lg`, in `components/studio/StudioPage.tsx`. Verify with Vitest in `StudioPage*.test.tsx`: switching tabs keeps chat history; the tab is restored from storage; a storage exception falls back to "Assistant"; and closing and reopening the drawer keeps typed text.
- [x] 3.4 Verify keyboard isolation with Vitest: with the notepad focused, Space does not toggle the transport, `r` does not record, Cmd/Ctrl+D does not duplicate, Cmd/Ctrl+Z undoes text without changing tracks, and Tab moves focus out.
- [x] 3.5 Add `frontend/e2e/lyrics.spec.ts` against the mock backend. It should cover: open the Lyrics tab → type a heading and two lines → wait for saved status → reload → lyrics restored → download project → open it as a new project → lyrics present. Verify `pnpm test:e2e` passes.

## 4. Integration checks

- [x] 4.1 Run `just lint` and `just test` from the repo root and verify both pass.
- [x] 4.2 Run `openspec validate add-lyric-notepad --strict` and verify it reports the change as valid.
- [x] 4.3 Run a manual smoke test in a browser at desktop and phone widths. Check that typing does not trigger shortcuts, that heading lines are styled, and that a project file with lyrics from one account opens in another. Note the results in the PR description.
