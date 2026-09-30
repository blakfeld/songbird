# Proposal

## Why

Many songwriters who also code, or who simply live in terminal editors, write fastest with vim keybindings. The request called this "pie in the sky". Because #9 builds the lyric notepad on CodeMirror 6, vim bindings are now a small, isolated extension rather than a new editor. This is the optional last step of the songwriting tools feature.

**Depends on:** #9 `add-lyrics-assistant`, which provides the CodeMirror-based lyric notepad and the `songwriting/lyrics` capability. This is PR 10 of 10 in the Songbird roadmap. Nothing depends on it, so it can be dropped or deferred without affecting any other change.

## What Changes

- **Vim mode toggle** in the lyric notepad toolbar. It is off by default. The setting is remembered per browser and applies to every song's notepad. It is not stored in songs or project files.
- **Modal editing** when the toggle is on: normal, insert, and visual modes with the everyday vim motions, operators, counts, registers, search, `.` repeat, and `u` / `Ctrl-R` undo and redo. These all operate on the notepad's own undo history.
- **Mode indicator** below the notepad, showing NORMAL, INSERT, or VISUAL and announced to screen readers.
- **Ex commands**: `:w` confirms that lyrics are saved automatically. Unsupported ex commands show a message and change nothing.
- **Shortcut isolation**: while the notepad has focus, vim keys never trigger page shortcuts. For example, Space does not toggle the transport and `u` does not undo a track edit. Escape leaves insert mode without closing panels or leaving the editor. Tab and Shift+Tab still move focus out of the editor, so keyboard users are never trapped.
- **Unchanged behavior**: the 20,000-character lyric limit, suggestion application (one undo step), and the chat panel behave the same in vim mode.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `songwriting/lyrics`: adds requirements for an optional vim keybinding mode in the lyric notepad. These cover the toggle and its persistence, modal editing, the mode indicator, ex commands, and shortcut and focus isolation. This capability is introduced by #9 `add-lyrics-assistant` and must be archived before this change.

## Impact

- **Frontend only**:
  - `components/lyrics/LyricsEditor.tsx` gets a keymap compartment.
  - New `components/lyrics/VimToggle.tsx` and `VimModeIndicator.tsx`.
  - New `lib/editorPrefs.ts` for the per-browser setting.
- **New dependency**: `@replit/codemirror-vim` (MIT, peer `@codemirror/*` 6.x, matching #9). It is loaded only when vim mode is on.
- **No backend or API changes.**
- **Non-goals**:
  - Vim bindings in the chat input, section notes, or other text fields.
  - A `.vimrc` or custom mappings.
  - Syncing the `"+` register with the system clipboard.
  - Emacs or other keymaps.
