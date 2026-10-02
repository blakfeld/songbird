# Tasks

## 1. Dependencies and preference store

- [ ] 1.1 In `frontend/`, add `@replit/codemirror-vim`, `@codemirror/language`, and `@codemirror/search` in one `pnpm add`, resolving against the installed `@codemirror/state`, `view`, and `commands` versions. Verify `pnpm why @codemirror/state` shows a single version and `pnpm build` succeeds.
- [ ] 1.2 Add `frontend/src/lib/editorPrefs.ts`: a zustand `persist` store under `songbird.editor.v1` holding `{vimMode: false}`, with a hydration flag. Verify with Vitest that the default is off, that the value survives re-creation of the store from the same storage, and that a downloaded song project file contains no vim setting.

## 2. Vim keymap in the notepad

- [ ] 2.1 Turn the limit-only `notice` in `components/lyrics/LyricsEditor.tsx` into a message area (design D4), keeping the limit message unchanged. Verify the existing `LyricsEditor.test.tsx` limit cases still pass.
- [ ] 2.2 Add a keymap `Compartment` to `LyricsEditor`, initialized from the preference store when the editor is created. On enable, dynamic-import `@replit/codemirror-vim` and reconfigure it to `vim()` ahead of the other extensions; on disable, reconfigure it to `[]`. Verify with Vitest that toggling on and off keeps the document, the selection, and `undoDepth`, that a newly created editor starts in vim mode when the preference is on, and that the vim module is never imported while the preference is off.
- [ ] 2.3 Register the ex commands per design D4 (`:w` shows the saved-automatically message; `:q`, `:wq`, `:x`, and `:e` show unsupported; other unknown commands go to the message area). Verify with Vitest calling the registered ex handlers that each message appears and the document is unchanged.
- [ ] 2.4 Add the wrapper keydown handler that calls `preventDefault()` and `stopPropagation()` on Escape while vim mode is on (design D5). Verify with a Vitest test that a document-level Escape listener is not called and the event is marked default-prevented when Escape is pressed in the notepad in vim mode, and that neither happens when vim mode is off.
- [ ] 2.5 Confirm the existing 20,000-character change filter also rejects vim puts. Verify with a Vitest test that dispatches a put-sized insert transaction at limit − 10 and sees it refused with the limit message.

## 3. Toggle and mode indicator UI

- [ ] 3.1 Add `components/lyrics/VimToggle.tsx` (a labelled switch in the Lyrics panel, disabled until the preference store hydrates) and `VimModeIndicator.tsx` (NORMAL/INSERT/VISUAL, `aria-live="polite"`, shown only in vim mode, subscribed to the vim mode-change event). Verify with Vitest that the switch updates the store and that the indicator text changes when a mode-change event fires. Get `ui-designer` review notes on the toggle's placement in the tab and the drawer.
- [ ] 3.2 Document vim mode (supported commands, `:w` behavior, and Tab to leave the editor) in the Lyrics panel's help text and the README's tools section. Verify the text matches the spec's supported command list.

## 4. End-to-end checks

- [ ] 4.1 Add Playwright tests in `frontend/e2e/lyrics-vim.spec.ts` against the mock backend. Cover these cases:
  - enable vim → `o` + text + Escape adds a line, with the indicator showing NORMAL;
  - `dd` deletes a line;
  - `3j` moves three lines;
  - type a line with vim off, enable vim, then `u` removes it;
  - Space in normal mode does not start playback, and `rx` replaces a character without starting recording;
  - Escape in insert mode keeps the Lyrics tab selected;
  - at a narrow viewport, Escape in insert mode keeps the Lyrics drawer open;
  - Tab in normal mode moves focus out of the editor;
  - reload and open another song → still in vim mode.

  Verify that `pnpm test:e2e` passes.
- [ ] 4.2 Run `just lint` and `just test` from the repo root and verify both pass.
- [ ] 4.3 Run `openspec validate add-lyrics-vim-mode --strict` and verify it reports the change as valid.
