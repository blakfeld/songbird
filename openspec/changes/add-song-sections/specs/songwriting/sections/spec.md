# Spec Delta

## Purpose

Lets songwriters divide a song into named sections (verse, chorus, bridge, and so on), reshape the arrangement a section at a time across every track, and keep notes on what each section is for.

## ADDED Requirements

### Requirement: Section structure
A song SHALL hold an ordered list of sections.
- Each section SHALL have:
  - an `id` that is unique within the song;
  - a `name` of 1–40 characters;
  - a `kind`, which is one of `intro`, `verse`, `pre-chorus`, `chorus`, `bridge`, `outro`, `other`;
  - `measures`, an integer from 1 to 32;
  - `notes`, a string of at most 5,000 characters.
- Sections SHALL tile the song in order, starting at measure 1, with no gaps or overlaps.
- The song's length in measures SHALL equal the sum of its section lengths, and SHALL NOT exceed 128.

#### Scenario: Sections tile the song
- **WHEN** a song has sections Intro (4), Verse (8), and Chorus (8)
- **THEN** the song is 20 measures long, and Verse covers measures 5–12 and Chorus covers measures 13–20

#### Scenario: Song cap enforced
- **WHEN** a song's sections total 124 measures and the user tries to add an 8-measure section
- **THEN** the section is not added and the user is told the song cannot exceed 128 measures

### Requirement: Implicit section for unsectioned songs
A song with no sections SHALL be shown as one implicit section. That section SHALL be named "Song", SHALL have kind `other`, and SHALL span the whole song.

The first structural edit or notes edit on an unsectioned song SHALL first turn the implicit section into a real section with the same name, kind, and length, and SHALL then apply the edit.

Songs saved before sections existed SHALL load without any change to their tracks or notes.

#### Scenario: Old song loads
- **WHEN** the user opens a 16-measure song that was saved before sections existed
- **THEN** the section ruler shows one section named "Song" covering measures 1–16, and every note is unchanged

#### Scenario: First edit materializes the section
- **WHEN** the user adds a 4-measure "Intro" before the implicit section of a 16-measure song
- **THEN** the song has two sections, Intro (4) and Song (16), and is 20 measures long

### Requirement: Adding and inserting sections
The user SHALL be able to add a section at the end of the song, or insert one immediately before or after the selected section. The user chooses its kind, name, and length.
- The length SHALL default to 8 measures.
- The name SHALL default to the kind's display name, numbered when that name is already used, for example "Verse 2".
- Inserting a section of N measures SHALL insert N empty measures into every track at the section's start. Every note at or after that point SHALL move later by N measures.

#### Scenario: Insert shifts later material
- **WHEN** a song has Verse (measures 1–8) and Chorus (measures 9–16), a track has a note at the first step of measure 9, and the user inserts a 4-measure Pre-Chorus after Verse
- **THEN** the Pre-Chorus covers measures 9–12, Chorus covers measures 13–20, and the note now starts at the first step of measure 13

#### Scenario: Default numbered name
- **WHEN** the song already has a section named "Verse" and the user adds another verse without changing the name
- **THEN** the new section is named "Verse 2"

### Requirement: Renaming and changing kind
The user SHALL be able to change a section's name and kind. Neither change SHALL alter any track's notes.

#### Scenario: Rename a section
- **WHEN** the user renames "Chorus" to "Hook"
- **THEN** the ruler shows "Hook" and no notes change

### Requirement: Resizing sections
The user SHALL be able to change a section's length to any value from 1 to 32 measures, as long as the song stays within 128 measures.
- **Lengthening** by N measures SHALL insert N empty measures into every track at the section's end. Later material SHALL move later by N measures.
- **Shortening** by N measures SHALL remove the section's last N measures from every track:
  - notes that start in the removed measures SHALL be deleted;
  - notes that cross into the removed measures SHALL be shortened to end at the new section end;
  - later material SHALL move earlier by N measures.

#### Scenario: Lengthen a verse
- **WHEN** Verse covers measures 1–8, Chorus covers measures 9–16, and the user resizes Verse to 12 measures
- **THEN** measures 9–12 are empty in every track, and Chorus and its notes now cover measures 13–20

#### Scenario: Shorten a section
- **WHEN** an 8-measure section has a note starting in its 8th measure and another note starting in its 6th measure that lasts 3 measures, and the user resizes the section to 6 measures
- **THEN** the note in the 8th measure is deleted, the other note ends at the end of the section's 6th measure, and the following section starts 2 measures earlier

### Requirement: Duplicating sections
The user SHALL be able to duplicate a section. The copy SHALL be inserted immediately after the original. It SHALL have the same kind, length, and notes, and a numbered name, for example "Chorus 2". The copy SHALL contain an exact copy of every track's notes that start within the original section. Later material SHALL move later by the section's length.

#### Scenario: Repeat a chorus
- **WHEN** the user duplicates an 8-measure Chorus covering measures 9–16
- **THEN** a section "Chorus 2" covers measures 17–24, and every track's notes in measures 17–24 match its notes in measures 9–16

### Requirement: Deleting sections
The user SHALL be able to delete a section when the song has more than one section. Deleting a section SHALL remove its measures from every track, including every note that starts within it. Later material SHALL move earlier by the section's length. Notes from an earlier section that cross into the deleted section SHALL be shortened to end at the deleted section's start. The last remaining section SHALL NOT be deletable.

#### Scenario: Delete a bridge
- **WHEN** the user deletes a 4-measure Bridge covering measures 17–20 in a 28-measure song
- **THEN** the song is 24 measures long, the Bridge's notes are gone, and the notes that were in measures 21–28 are now in measures 17–24

#### Scenario: Cannot delete the only section
- **WHEN** a song has exactly one section
- **THEN** the delete action for that section is unavailable

### Requirement: Song length control with sections
While a song has sections, changing the song's length with the song-length control SHALL resize the last section by the difference and follow the resizing rules. A change that would make the last section shorter than 1 measure or longer than 32 measures SHALL NOT be offered.

#### Scenario: Lengthen the song
- **WHEN** a song ends with a 4-measure Outro and the user raises the song length by 4 measures
- **THEN** the Outro becomes 8 measures long

### Requirement: Section ruler
The song page SHALL show a section ruler aligned with the tracks' measure grid. It SHALL display each section's name across its measures, with section boundaries visually distinct, and SHALL scroll horizontally together with the tracks.

#### Scenario: Ruler aligns with the grid
- **WHEN** a song has Intro (4) and Verse (8)
- **THEN** the Verse label starts directly above the first step of measure 5 in every track

### Requirement: Selecting a section
The user SHALL be able to select a section by clicking it on the ruler. Selecting a section SHALL set the playback loop range to that section's measures. When per-track generation is available, the selected section SHALL become its default measure range. At most one section SHALL be selected at a time, and the user SHALL be able to clear the selection.

#### Scenario: Loop the chorus
- **WHEN** the user selects a Chorus covering measures 9–16 and presses Play
- **THEN** only measures 9–16 play, and they repeat

### Requirement: Section notes
The song page SHALL provide a notes field for the selected section. Edits to that field SHALL be saved to the section. The field SHALL accept at most 5,000 characters and SHALL indicate when the limit is reached. The field SHALL be a text-entry target, so global editor shortcuts such as Space for play or stop SHALL NOT fire while it has focus.

#### Scenario: Notes are kept per section
- **WHEN** the user types "call and response with the guitar" into Chorus's notes, selects Verse, and then selects Chorus again
- **THEN** Chorus's notes field shows "call and response with the guitar" and Verse's notes are unaffected

#### Scenario: Typing a space does not start playback
- **WHEN** the notes field has focus and the user presses Space
- **THEN** a space is typed into the notes and playback does not start

### Requirement: Undo and persistence of sections
Every structural section edit SHALL be undoable and redoable with the song editor's undo and redo, restoring both the sections and all affected notes. These edits are add, insert, rename, change kind, resize, duplicate, and delete.

Sections, including their notes, SHALL be saved with the song in the browser and SHALL be included in the song project file. Reloading the page SHALL restore them.

#### Scenario: Undo a delete
- **WHEN** the user deletes a section and then presses Cmd/Ctrl+Z
- **THEN** the section and every note it contained are restored at their original positions

#### Scenario: Reload keeps sections
- **WHEN** the user creates sections with notes and reloads the page
- **THEN** the same sections, lengths, and notes are shown
