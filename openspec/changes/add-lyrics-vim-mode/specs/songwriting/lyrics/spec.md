# Spec Delta

## ADDED Requirements

### Requirement: Vim mode toggle
The lyric notepad SHALL offer a "Vim mode" toggle that is off by default. The setting SHALL be remembered in the browser across reloads and SHALL apply to the notepad of every song. It SHALL NOT be stored in songs or song project files. Turning vim mode on or off SHALL keep the notepad's text, cursor position, and undo history. When vim mode is off, the notepad SHALL behave exactly as it does without this feature.

#### Scenario: Off by default
- **WHEN** a user opens the lyric notepad for the first time in a browser
- **THEN** vim mode is off and typed characters are inserted as text

#### Scenario: Setting survives reload and applies to all songs
- **WHEN** the user turns vim mode on, reloads the page, and opens a different song
- **THEN** that song's notepad is in vim mode

#### Scenario: Not part of the song
- **WHEN** the user downloads a song project file with vim mode on
- **THEN** the file contains no vim-mode setting

#### Scenario: Toggling keeps work
- **WHEN** the user has made edits in vim mode and turns vim mode off
- **THEN** the text and cursor position are unchanged and Cmd/Ctrl+Z still undoes those edits

### Requirement: Modal editing
When vim mode is on, the notepad SHALL start in normal mode when it gains focus. It SHALL support at least the following:
- Moving between normal, insert (`i`, `a`, `I`, `A`, `o`, `O`), and visual (`v`, `V`) modes, with Escape returning to normal mode.
- Motions `h j k l w b e 0 $ gg G`, with numeric counts.
- Operators `d`, `c`, `y` combined with motions, and the line forms `dd`, `cc`, `yy`.
- `x`, `p`, `P`, `.` (repeat), `/` and `n` / `N` search, and `u` / `Ctrl-R` undo and redo.

Undo and redo in vim mode SHALL use the same history as Cmd/Ctrl+Z in the notepad. Every edit made in vim mode SHALL obey the lyrics length limit.

#### Scenario: Normal mode does not insert text
- **WHEN** vim mode is on, the notepad is in normal mode, and the user types `dd`
- **THEN** the current line is deleted and no "d" characters are inserted

#### Scenario: Insert and return
- **WHEN** the user presses `o`, types "new line", and presses Escape
- **THEN** a line "new line" is added below the cursor line and the notepad is in normal mode

#### Scenario: Counted motion
- **WHEN** the cursor is on line 1 of a 10-line notepad in normal mode and the user types `3j`
- **THEN** the cursor moves to line 4

#### Scenario: Vim undo matches editor undo
- **WHEN** the user applies an assistant suggestion and then presses `u` in normal mode
- **THEN** the lyrics return to their state before the suggestion was applied

#### Scenario: Put respects the length limit
- **WHEN** the notepad is 10 characters below its limit and the user puts a yanked 50-character line with `p`
- **THEN** the put is refused, the lyrics are unchanged, and the user is told the limit was reached

### Requirement: Vim mode indicator
While vim mode is on, the notepad SHALL show the current mode (NORMAL, INSERT, or VISUAL) next to the editor. Mode changes SHALL be announced to assistive technology without moving focus.

#### Scenario: Indicator follows mode
- **WHEN** the user presses `i` in normal mode
- **THEN** the indicator changes from NORMAL to INSERT and the change is announced politely to screen readers

### Requirement: Vim ex commands
In vim mode, `:w` SHALL show the message "Lyrics are saved automatically" and change nothing. Any other ex command that the notepad does not support SHALL show a message naming the command as unsupported and SHALL change nothing. Ex commands SHALL NOT navigate away from, close, or reload the page.

#### Scenario: Write command
- **WHEN** the user types `:w` and presses Enter in normal mode
- **THEN** the message "Lyrics are saved automatically" is shown and the lyrics are unchanged

#### Scenario: Quit command does nothing
- **WHEN** the user types `:q` and presses Enter
- **THEN** a message says `:q` is unsupported and the page, song, and lyrics are unchanged

### Requirement: Shortcut and focus isolation in vim mode
While the notepad has focus in vim mode, no keystroke SHALL trigger a page-level shortcut, in any vim mode. This includes the transport's Space toggle and song-level undo and redo. Escape SHALL NOT close panels or dialogs, or move focus out of the notepad. Tab and Shift+Tab pressed in normal mode SHALL move focus to the next or previous focusable element, so the user can always leave the editor with the keyboard.

#### Scenario: Space moves the cursor, not the transport
- **WHEN** a song is stopped, the notepad has focus in normal mode, and the user presses Space
- **THEN** playback does not start

#### Scenario: Escape stays in the editor
- **WHEN** the notepad is in insert mode and the user presses Escape
- **THEN** the notepad switches to normal mode, keeps focus, and the Lyrics panel stays open

#### Scenario: Keyboard exit
- **WHEN** the notepad is in normal mode and the user presses Tab
- **THEN** focus moves to the next focusable control after the notepad
