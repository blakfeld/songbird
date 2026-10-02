# Proposal

## Why

Many songwriters who also code, or who simply live in terminal editors, write fastest with vim keybindings. The request called this "pie in the sky". Because the lyric notepad is already built on CodeMirror 6, vim bindings are a small, isolated extension rather than a new editor. This is an optional step of the songwriting tools feature.

**Depends on:** `add-lyric-notepad` (archived), which provides the CodeMirror-based lyric notepad and the `songwriting/lyrics` capability. It does not depend on `add-lyrics-assistant`, and can land before or after it. Nothing depends on this change, so it can be dropped or deferred without affecting any other change.

## What Changes

- **Vim mode toggle** in the lyric notepad. It is off by default. The setting is remembered per browser and applies to every song's notepad. It is not stored in songs or project files.
- **Modal editing** when the toggle is on: normal, insert, and visual modes with the everyday vim motions, operators, counts, registers, search, `.` repeat, and `u` / `Ctrl-R` undo and redo. These all operate on the notepad's own undo history.
- **Mode indicator** below the notepad, showing NORMAL, INSERT, or VISUAL and announced to screen readers.
- **Ex commands**: `:w` confirms that lyrics are saved automatically. Unsupported ex commands show a message and change nothing.
- **Keyboard isolation**: the notepad's existing isolation from Studio shortcuts holds in every vim mode. In addition, Escape leaves insert mode without closing the Lyrics drawer or other dialogs, and Tab and Shift+Tab in normal mode still move focus out of the editor, so keyboard users are never trapped.
- **Unchanged behavior**: the 20,000-character lyric limit and the separation of lyrics undo from song undo behave the same in vim mode. If `add-lyrics-assistant` has landed, applying a suggestion is still one undo step, and `u` reverts it.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `songwriting/lyrics`: adds requirements for an optional vim keybinding mode in the lyric notepad. These cover the toggle and its persistence, modal editing, the mode indicator, ex commands, and keyboard isolation in vim mode.

## Impact

- **Frontend only**:
  - `components/lyrics/LyricsEditor.tsx` gets a keymap compartment, and its limit-only notice becomes a general message area.
  - New `components/lyrics/VimToggle.tsx` and `VimModeIndicator.tsx`.
  - New `lib/editorPrefs.ts` for the per-browser setting.
- **New dependencies**: `@replit/codemirror-vim` (MIT, peer `@codemirror/*` 6.x, matching the notepad's installed versions), plus `@codemirror/language` and `@codemirror/search` as its peers. The vim package is loaded only when vim mode is on.
- **No backend or API changes.**
- **Non-goals**:
  - Vim bindings in the chat input, section notes, or other text fields.
  - A `.vimrc` or custom mappings.
  - Syncing the `"+` register with the system clipboard.
  - Emacs or other keymaps.
  - Storing the setting on the user's account.
