# Spec Delta

## ADDED Requirements

### Requirement: Lyrics on notes
When a note carries a `lyric` (see `songwriting/topline`), the piano roll SHALL show the lyric on or beside the note. A lyric that is too long to fit SHALL be shortened with an ellipsis. The note's accessible label SHALL include the full lyric. Notes without a lyric SHALL be drawn as before.

The note's lyric SHALL be kept when the note is moved, resized, nudged, or given a new velocity, and when the note is copied, cut and pasted, or duplicated. A note the user adds SHALL have no lyric. Deleting a note SHALL delete its lyric.

When exactly one note is selected, the note inspector SHALL show a "Lyric" field holding the note's lyric, or empty when it has none. Committing the field SHALL set the lyric, or remove it when the field is empty, as one undo step. Text longer than 16 characters, or containing a line break, SHALL be refused, and the user SHALL be told why. When several selected notes carry lyrics, the inspector SHALL offer "Clear lyrics", which removes them as one undo step.

Lyrics SHALL NOT change how notes sound.

#### Scenario: Syllables shown on notes
- **WHEN** the dock shows a loop whose notes carry `hold`, `me`, and `close`
- **THEN** each note shows its syllable, and the first note's accessible label includes "hold"

#### Scenario: Moving keeps the syllable
- **WHEN** the user drags the note carrying `me` two steps later and up a semitone
- **THEN** the moved note still carries `me`

#### Scenario: Paste carries syllables
- **WHEN** the user copies two notes carrying `oh` and `oh` and pastes them elsewhere in the loop
- **THEN** the pasted notes carry `oh` and `oh`

#### Scenario: Edit a syllable
- **WHEN** one note carrying `me` is selected and the user changes the inspector's Lyric field to `you` and commits
- **THEN** the note carries `you`, and one Cmd/Ctrl+Z restores `me`

#### Scenario: Over-long syllable refused
- **WHEN** the user enters a 17-character lyric in the inspector
- **THEN** the note's lyric is unchanged and the user is told the limit
