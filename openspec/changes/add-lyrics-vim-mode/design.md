# Design

## Context

`add-lyric-notepad` built the lyric notepad as a CodeMirror 6 `EditorView` in `frontend/src/components/lyrics/LyricsEditor.tsx`, using `@codemirror/state`, `view` and `commands` 6.x. It uses `history()`, the default and history keymaps without `indentWithTab`, and a 20,000-character `changeFilter` with a limit-only notice. A fresh editor is keyed per song. `LyricsPanel` is shown in the Studio's right-column Lyrics tab on wide screens, and inside a `ModalDialog` drawer on narrow screens. Three things matter for key handling:
- Studio shortcuts (`components/editor/useEditorShortcuts.ts`) ignore events whose target passes `isTextEntryTarget` (`lib/pianoRoll.ts`). CodeMirror's content element is `contenteditable`, so Space, `r`, Cmd+Z, and other shortcuts already skip the notepad. The main spec's "Notepad keyboard isolation" requirement pins this.
- The narrow-screen Lyrics drawer is a native modal `<dialog>` (`components/ui/ModalDialog.tsx`), which the browser closes on Escape. Popovers and menus (`AnchoredPopover`, `Menu`) also listen for Escape.
- If `add-lyrics-assistant` has landed, it applies suggestions as single `input.suggestion` transactions through the same editor.

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
It is the maintained CodeMirror 6 vim layer (6.x, MIT). Its peers are `@codemirror/{state,view,commands,language,search}` 6.x. It supports modes, motions, operators, counts, registers, `.`, and `/` search, and it exposes `Vim.defineEx` and mode-change events (`vim-mode-change` on the CodeMirror adapter). It has no React dependency, so React 19 and Next 16 compatibility reduces to the notepad's existing client-only wrapper.

- `@codemirror/language` and `@codemirror/search` are added as direct dependencies so pnpm resolves exactly one copy of each `@codemirror/*` package. Duplicate `@codemirror/state` instances break extensions at runtime.
- **Alternative considered:** a hand-written modal keymap. Rejected: the spec's motion and operator surface is large, and the library already covers it.

### D2. A compartment plus dynamic import
`LyricsEditor` holds a `Compartment` for the keymap layer.
- When vim is enabled, it `await import("@replit/codemirror-vim")` and reconfigures the compartment with `vim()`. The vim extension must have higher precedence than the default keymap, so it goes first in the extension list, as the library requires.
- When vim is disabled, it reconfigures the compartment to `[]`.
- Reconfiguring keeps the `EditorState`, so text, selection, and `history()` survive (spec "Toggling keeps work").
- Because the editor is re-created per song, the compartment's initial value is read from the preference store at creation, so switching songs keeps vim mode.
- Vim's `u` / `Ctrl-R` call CodeMirror's `undo` / `redo`, so they share the notepad history. Any single-transaction edit, such as a co-writer suggestion, stays one undo step.

### D3. The per-browser preference in `lib/editorPrefs.ts`
The preference is a small zustand `persist` store under localStorage key `songbird.editor.v1` with `{vimMode: boolean}`. This keeps it separate from songs, so project files never carry it.

It also reads the stored value safely during hydration. The notepad already renders client-only, so no SSR mismatch arises. The toggle is disabled until the store hydrates, which avoids a flash of the wrong mode.

**Alternative considered:** storing it on the user's account. Accounts exist now, but there is no user-preferences store, and adding one (schema, endpoint, sync) is far more than this optional feature warrants. The Studio's remembered right-column tab is already a per-browser setting, so this matches it.

### D4. Ex commands and the notice area
- The editor's limit-only notice becomes a general message area: `notice` holds a message string instead of a boolean, and the limit message is one of its values.
- Register `Vim.defineEx("write", "w", …)` to show "Lyrics are saved automatically" in that area.
- Override `quit`/`q`, `wq`, `x`, and `edit`/`e` to show "unsupported". The library's default `:q` does nothing in a browser, but an explicit message is clearer.
- The library reports other unknown commands through its own dialog. Configure it to route that message to the same area, so there is no stray DOM.

### D5. Escape and Tab isolation
The notepad wrapper gets a keydown listener that, while vim mode is on, calls both `preventDefault()` and `stopPropagation()` for Escape after CodeMirror has handled it.
- `stopPropagation()` keeps document-level Escape listeners, such as popovers and menus, from seeing it.
- `preventDefault()` is what keeps the narrow-screen drawer open. A modal `<dialog>` closes on Escape through the browser's close request, not through a JS listener, and a cancelled keydown suppresses that request. Stopping propagation alone would leave the drawer closing.
- A Playwright test in a real browser pins the drawer behavior, because jsdom does not implement dialog close requests.

For Tab:
- `indentWithTab` is not used, so Tab already moves focus.
- A test pins this, because a future `indentWithTab` would silently trap keyboard users.

Space, `r`, and Cmd+Z isolation needs no new code because of `isTextEntryTarget`. It is pinned by tests in normal mode, since the existing notepad tests only cover insert-style typing.

### D6. The mode indicator
The indicator subscribes to the vim adapter's mode-change event and renders the mode in an element with `aria-live="polite"` and `aria-atomic="true"` beside the character counter. It only renders while vim mode is on.

## Risks / Trade-offs

- **[Risk] `@codemirror/*` version skew between the notepad's installed packages and the vim peer range, which silently breaks extensions.** → Mitigation: install the new packages in one `pnpm add` that resolves against the existing `@codemirror/*` versions, check `pnpm why @codemirror/state` shows one version, and add a Vitest check that `vim()` mounts on the same `EditorState` as the notepad's extensions.
- **[Risk] jsdom cannot faithfully simulate CodeMirror key handling for vim sequences, or dialog close requests.** → Mitigation: pure behavior (pref store, ex messages, Escape propagation) is tested in Vitest. Modal editing and the drawer staying open are covered by Playwright in a real browser.
- **[Trade-off] Vim mode is per browser rather than per account or per song.** A user who switches devices turns it on again. A per-song setting would leak into shared project files.
- **[Trade-off] The vim chunk is roughly 100 KB (min).** It is loaded only on first enable, so there is a one-time delay of well under a second on toggle.

## Migration Plan

This change is additive and frontend-only. Rollback is to revert the PR. A stale `songbird.editor.v1` key is then ignored.
