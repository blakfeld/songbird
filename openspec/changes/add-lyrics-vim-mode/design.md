# Design

## Context

#9 builds the lyric notepad as a CodeMirror 6 `EditorView` in `frontend/src/components/lyrics/LyricsEditor.tsx`. It uses `history()`, the default keymap, a 20,000-character `changeFilter`, and single-transaction suggestion application (see #9 design D6 and D7). Two things matter for key handling:
- Page-level shortcuts (`frontend/src/components/editor/useEditorShortcuts.ts:25`) ignore events whose target passes `isTextEntryTarget` (`frontend/src/lib/pianoRoll.ts:25-32`). CodeMirror's content element is `contenteditable`, so Space, Cmd+Z, and other page shortcuts already skip the notepad.
- The `/studio` Lyrics panel and any dialogs may listen for Escape on `document`.

The motivation is in proposal.md. The requirements are in `specs/songwriting/lyrics/spec.md`.

## Goals / Non-Goals

**Goals:**
- Vim bindings cost nothing when they are off: no bundle weight and no behavior change.
- Turning vim on or off never loses text, cursor position, or undo history.

**Non-Goals:**
- Maintaining our own vim emulation.
- Vim in other text fields.
- Clipboard register sync.

## Decisions

### D1. Use `@replit/codemirror-vim`
It is the maintained CodeMirror 6 vim layer (6.x, MIT). Its peers are `@codemirror/{state,view,commands,language,search}` 6.x. It supports modes, motions, operators, counts, registers, `.`, and `/` search, and it exposes `Vim.defineEx` and mode-change events (`vim-mode-change` on the CodeMirror adapter). It has no React dependency, so React 19 and Next 16 compatibility reduces to #9's client-only wrapper.

- `@codemirror/language` and `@codemirror/search` are added as direct dependencies so pnpm resolves exactly one copy of each `@codemirror/*` package. Duplicate `@codemirror/state` instances break extensions at runtime.
- **Alternative considered:** a hand-written modal keymap. Rejected: the spec's motion and operator surface is large, and the library already covers it.

### D2. A compartment plus dynamic import
`LyricsEditor` holds a `Compartment` for the keymap layer.
- When vim is enabled, it `await import("@replit/codemirror-vim")` and reconfigures the compartment with `vim()`. The vim extension must have higher precedence than the default keymap, so it goes first in the extension list, as the library requires.
- When vim is disabled, it reconfigures the compartment to `[]`.
- Reconfiguring keeps the `EditorState`, so text, selection, and `history()` survive (spec "Toggling keeps work").
- Vim's `u` / `Ctrl-R` call CodeMirror's `undo` / `redo`, so they share the notepad history, and suggestion application stays one undo step.

### D3. The per-browser preference in `lib/editorPrefs.ts`
The preference is a small zustand `persist` store under localStorage key `songbird.editor.v1` with `{vimMode: boolean}`. This keeps it separate from songs, so project files never carry it.

It also reads the stored value safely during hydration. The notepad already renders client-only (#9 D6), so no SSR mismatch arises. The toggle is disabled until the store hydrates, which avoids a flash of the wrong mode.

### D4. Ex commands
- Register `Vim.defineEx("write", "w", …)` to show the "saved automatically" notice through the notepad's existing notice area from #9.
- Override `quit`/`q`, `wq`, `x`, and `edit`/`e` to show "unsupported". The library's default `:q` does nothing in a browser, but an explicit message is clearer.
- The library reports other unknown commands through its own dialog. Configure it to route that message to the same notice area, so there is no stray DOM.

### D5. Escape and Tab isolation
The notepad root gets a keydown listener on its wrapper element that calls `stopPropagation()` for Escape while vim mode is on. The listener runs after CodeMirror handles the key. Document-level Escape listeners, such as dialogs and panel close actions, then never see it.

For Tab:
- Neither the default keymap nor `indentWithTab` is used (#9 does not add it), so Tab already moves focus.
- A Vitest or Playwright test pins this down, because a future `indentWithTab` would silently trap keyboard users.

Space and Cmd+Z isolation needs no new code because of `isTextEntryTarget`. It is pinned by a test in insert mode and one in normal mode.

### D6. The mode indicator
The indicator subscribes to the vim adapter's mode-change event and renders the mode in an element with `aria-live="polite"` and `aria-atomic="true"` beside the character counter. It only renders while vim mode is on.

## Risks / Trade-offs

- **[Risk] `@codemirror/*` version skew between #9's pinned packages and the vim peer range, which silently breaks extensions.** → Mitigation: install all `@codemirror/*` packages from one `pnpm add` invocation, and add a Vitest check that `vim()` mounts on the same `EditorState` as #9's extensions.
- **[Risk] jsdom cannot faithfully simulate CodeMirror key handling for vim sequences.** → Mitigation: pure behavior (pref store, ex messages, Escape propagation) is tested in Vitest. Modal-editing scenarios are covered by Playwright in a real browser.
- **[Trade-off] Vim mode is per browser rather than per user or per song.** There are no accounts, and a per-song setting would leak into shared project files.
- **[Trade-off] The vim chunk is roughly 100 KB (min).** It is loaded only on first enable, so there is a one-time delay of well under a second on toggle.

## Migration Plan

This change is additive and frontend-only. Rollback is to revert the PR. A stale `songbird.editor.v1` key is then ignored.
