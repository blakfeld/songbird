# Spec Delta

## Purpose

Gives each song a lyric notepad on the Studio page, so songwriters can write the words alongside the arrangement and keep them with the song wherever it is stored or exported.

## ADDED Requirements

### Requirement: Lyric notepad per song
Each song SHALL have exactly one lyric notepad: a multi-line plain-text editor on the Studio page. The notepad SHALL show the open song's lyrics. When a different song is opened, the notepad SHALL show that song's lyrics instead. A song without lyrics SHALL show an empty notepad with a placeholder inviting the user to write.

#### Scenario: Lyrics are per song
- **WHEN** the user writes lyrics in song A and then opens song B
- **THEN** the notepad shows song B's lyrics, and reopening song A shows song A's lyrics

#### Scenario: Song without lyrics
- **WHEN** a song saved before lyrics existed is opened
- **THEN** the notepad is empty and the song otherwise opens unchanged

### Requirement: Lyrics panel placement
On wide screens, the Studio's right column SHALL offer two tabs, "Assistant" and "Lyrics", and SHALL show one panel at a time. The selected tab SHALL be remembered in the browser across reloads. It SHALL NOT be stored in the song. On narrow screens, where the assistant opens in a drawer, the Studio SHALL offer a "Lyrics" button that opens the notepad in the same kind of drawer. Switching tabs or closing the drawer SHALL NOT lose unsaved typing.

#### Scenario: Switch to lyrics
- **WHEN** on a wide screen the user selects the "Lyrics" tab
- **THEN** the notepad replaces the assistant chat in the right column, and selecting "Assistant" brings the chat back with its history intact

#### Scenario: Tab remembered
- **WHEN** the user selects the "Lyrics" tab and reloads the page
- **THEN** the right column shows the Lyrics tab

#### Scenario: Narrow screen
- **WHEN** on a narrow screen the user presses "Lyrics", types a line, and closes the drawer
- **THEN** reopening the drawer shows the line

### Requirement: Lyrics saved with the song
Lyrics SHALL be part of the song document as an optional `lyrics` string. Editing lyrics SHALL save the song through the same autosave as other song edits, so reloading the page or opening the song on another device shows the latest saved lyrics. Lyrics SHALL be included in "Download project" files and SHALL be loaded from "Open project" files. A song or project file without `lyrics` SHALL load with empty lyrics. A song whose lyrics are empty SHALL be saved and downloaded without a `lyrics` field, exactly as before this change.

#### Scenario: Lyrics survive reload
- **WHEN** the user types lyrics, waits for the song to show as saved, and reloads the page
- **THEN** the same song shows the same lyrics

#### Scenario: Project file round trip
- **WHEN** the user downloads a project for a song with lyrics and opens that file
- **THEN** the new project's notepad shows the same lyrics

#### Scenario: Empty lyrics leave the file unchanged
- **WHEN** a song with no lyrics is downloaded as a project
- **THEN** the song document in the file has no `lyrics` field

### Requirement: Lyrics length limit
Lyrics SHALL hold at most 20,000 characters, counted as Unicode scalar values. The notepad SHALL show the current count against the limit once the lyrics exceed 18,000 characters. Input that would take the lyrics past the limit SHALL be refused as a whole: the lyrics SHALL stay unchanged and the user SHALL be told the limit was reached. Saving or creating a project whose song has lyrics over the limit SHALL be refused with `422` and code `invalid_song`, storing nothing. "Open project" SHALL reject such a file with a message naming the lyrics limit.

#### Scenario: Paste past the limit
- **WHEN** the notepad holds 19,990 characters and the user pastes 50 characters
- **THEN** the paste is refused, the lyrics still hold 19,990 characters, and the user is told the limit was reached

#### Scenario: Counter appears near the limit
- **WHEN** the lyrics grow from 18,000 to 18,001 characters
- **THEN** a counter showing 18,001 of 20,000 appears

#### Scenario: Server rejects oversized lyrics
- **WHEN** a client saves a project whose song has 20,001 characters of lyrics
- **THEN** the server responds `422` with code `invalid_song` and the stored project is unchanged

#### Scenario: Limit counts characters, not bytes
- **WHEN** a client saves a song whose lyrics are 20,000 multi-byte characters
- **THEN** the save succeeds

### Requirement: Lyric headings
A notepad line that consists only of a bracketed name, such as `[Chorus]` or `[Verse 1]`, optionally surrounded by whitespace, SHALL be shown visually distinct from lyric lines. Headings SHALL NOT change the stored text, which SHALL remain exactly what the user typed.

#### Scenario: Heading line styled
- **WHEN** the notepad contains the line `[Chorus]`
- **THEN** that line is shown as a heading and the lines under it are shown as lyric lines

#### Scenario: Brackets inside a lyric line
- **WHEN** a line reads `I said [softly] goodbye`
- **THEN** the line is shown as a lyric line, not a heading

### Requirement: Lyrics undo is separate from song undo
The notepad SHALL provide its own undo and redo, via Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z while it has focus. Typing in the notepad SHALL NOT add steps to the song's undo history. Song undo and redo SHALL NOT change the lyrics, and notepad undo SHALL NOT change anything but the lyrics.

#### Scenario: Song undo keeps lyrics
- **WHEN** the user adds a track, then types a lyric line, then clicks the Studio's Undo button
- **THEN** the track is removed and the lyric line remains

#### Scenario: Notepad undo
- **WHEN** the user types a lyric line and presses Cmd/Ctrl+Z while the notepad has focus
- **THEN** the line is removed and the song's tracks are unchanged

### Requirement: Notepad keyboard isolation
While the notepad has focus, key presses SHALL edit the lyrics and SHALL NOT trigger Studio shortcuts. For example, Space SHALL NOT start or stop playback, `r` SHALL NOT start recording, and Cmd/Ctrl+D SHALL NOT duplicate a clip. Tab and Shift+Tab SHALL move focus out of the notepad rather than insert a tab, so keyboard users are never trapped. The notepad SHALL have an accessible name of "Lyrics".

#### Scenario: Space types a space
- **WHEN** the notepad has focus and the user presses Space
- **THEN** a space is inserted and playback does not start

#### Scenario: Tab leaves the notepad
- **WHEN** the notepad has focus and the user presses Tab
- **THEN** focus moves to the next focusable control and the lyrics are unchanged
