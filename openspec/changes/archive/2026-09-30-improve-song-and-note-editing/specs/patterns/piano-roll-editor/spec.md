# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Drag a note to another row`
- TO: `### Requirement: Moving notes`

## MODIFIED Requirements

### Requirement: Editing notes
The user SHALL be able to add a note by clicking an empty cell. Clicking a note SHALL select it (see "Selecting notes") and SHALL NOT remove it. The user SHALL be able to remove notes by:
- double-clicking a note, which removes that note;
- pressing Delete or Backspace while the piano roll has focus, which removes every selected note.

The user SHALL be able to change a note's velocity (1–127) with the note inspector (see "Editing selected notes") or with Shift-drag.

A new note SHALL have velocity 100. Its length SHALL be:
- 1 step for a one-shot instrument;
- one beat for a sustained instrument, which is 4 steps in 4/4 and 3/4 and 6 steps in 6/8. This length SHALL be shortened so it ends before the next note in the same row and within the pattern.

Adding a note SHALL clear the selection. Edits SHALL be reflected immediately in the piano roll, playback, and export.

#### Scenario: Add a note
- **WHEN** the user clicks an empty cell in the snare row at step 4
- **THEN** a snare note with length 1 and velocity 100 appears at step 4

#### Scenario: Add a sustained note
- **WHEN** the user clicks an empty cell in the `E4` row of a 4/4 piano pattern at step 0
- **THEN** an `E4` note with length 4 and velocity 100 appears at step 0

#### Scenario: Sustained default is clipped by the next note
- **WHEN** a 4/4 piano pattern has an `E4` note at step 2 and the user clicks the empty `E4` cell at step 0
- **THEN** a note with length 2 appears at step 0

#### Scenario: Clicking a note selects it
- **WHEN** the user clicks a note
- **THEN** the note is selected and is not removed

#### Scenario: Remove a note
- **WHEN** the user double-clicks a note
- **THEN** the note is removed

#### Scenario: Delete the selection
- **WHEN** three notes are selected and the user presses Delete
- **THEN** all three notes are removed, and a single Cmd/Ctrl+Z restores them

#### Scenario: Edit velocity
- **WHEN** the user sets a note's velocity to 40
- **THEN** the note is drawn at reduced intensity and plays and exports with velocity 40

### Requirement: Moving notes
The user SHALL be able to move notes by dragging them in any direction in a piano roll.
- **What moves:** dragging a selected note SHALL move every selected note together. Dragging an unselected note SHALL select only that note and move it.
- **Snapping:** the moved notes SHALL follow the pointer in whole steps horizontally and whole rows vertically. Each note SHALL keep its length and velocity, and the notes SHALL keep their positions relative to each other.
- **Staying in bounds:** a move SHALL NOT place any moved note before step 0, past the end of the grid, or outside the instrument's rows.
- **Collisions:** a move SHALL NOT make a moved note overlap a note that is not being moved. When the pointer reaches such a position, the notes SHALL stay at the last position where they fit.
- **Preview sound:** each time the dragged note enters a new row, that row's sound SHALL play once at the dragged note's velocity. The rows of the other moved notes SHALL NOT play.
- **Undo:** a whole drag SHALL be recorded as one undo step. A drag that ends where it started SHALL NOT be recorded.
- **Keyboard:** while the piano roll has focus, Alt+Up and Alt+Down SHALL move the selection, or the focused note when nothing is selected, by one row. Alt+Left and Alt+Right SHALL move it by one step. The same bounds and collision rules SHALL apply.

This applies to the single-instrument editor pages and to the Studio piano roll. On the Studio, the preview SHALL follow the rules of "Placing a note previews it".

#### Scenario: Drag a note up two semitones
- **WHEN** the user drags a `C4` note at step 8 upward by two rows
- **THEN** the note is a `D4` at step 8 with its length and velocity unchanged, `C#4` and `D4` each played once during the drag, and one Cmd/Ctrl+Z returns it to `C4`

#### Scenario: Drag a note later in time
- **WHEN** the user drags a `C4` note at step 8 three steps to the right
- **THEN** the note is a `C4` at step 11 with its length and velocity unchanged

#### Scenario: Move a selection as a block
- **WHEN** notes at (`C4`, step 0) and (`E4`, step 4) are selected and the user drags the `C4` note up one row and right two steps
- **THEN** the notes are at (`C#4`, step 2) and (`F4`, step 6)

#### Scenario: Occupied row is skipped
- **WHEN** the user drags a note toward a position where it would overlap an unselected note in the same row and releases there
- **THEN** the note stays at the last position it passed where it fit, and the other note is unchanged

### Requirement: Shift-drag a note to change its velocity
Holding Shift while dragging a note vertically SHALL change velocity instead of moving the note.
- The change SHALL apply to the dragged note, or to every selected note when the dragged note is selected.
- Every affected note SHALL change by the same amount, clamped to 1–127.
- The dragged note SHALL show its value while dragging.
- Start steps, lengths, and rows SHALL be unchanged.
- A whole drag SHALL be one undo step, and velocity changes SHALL NOT play notes.
- The note's tooltip SHALL say that Shift-drag changes velocity.

This applies to the single-instrument editor pages and to the Studio piano roll.

#### Scenario: Plain vertical drag changes pitch, Shift drag changes velocity
- **WHEN** the user drags a note upward without Shift, and then drags it upward holding Shift
- **THEN** the first drag moves the note to a higher row, and the second raises its velocity without moving it

#### Scenario: Shift-drag a selection
- **WHEN** notes with velocities 60 and 120 are selected and the user Shift-drags one of them up by 20
- **THEN** their velocities are 80 and 127

## ADDED Requirements

### Requirement: Selecting notes
A piano roll SHALL let the user select one or more of its notes.
- **Clicking:** clicking a note SHALL select only that note. Shift-click or Cmd/Ctrl-click SHALL add the note to the selection, or remove it if it is already selected.
- **Selection box:** pressing on empty grid space and dragging at least 4 pixels SHALL draw a selection box. Releasing SHALL select every note the box touches. If Shift was held when the drag started, those notes SHALL be added to the current selection instead of replacing it. Pressing and releasing without dragging SHALL add a note, as described in "Editing notes".
- **Keyboard:** while the piano roll has focus, Cmd/Ctrl+A SHALL select every note in the grid, and Escape SHALL clear the selection.
- **Appearance:** selected notes SHALL be drawn with an outline that is visible without relying on colour. Each note's accessible name SHALL say when it is selected.
- **Lifetime:** the selection SHALL NOT be recorded in undo history. It SHALL be cleared when the grid shows a different pattern or loop.

#### Scenario: Box select
- **WHEN** the user drags a box from step 0 of row `C4` to step 7 of row `G4`
- **THEN** every note that starts or extends into steps 0–7 in rows `C4` through `G4` is selected, and no other note is

#### Scenario: Extend a selection
- **WHEN** two notes are selected and the user Shift-clicks a third note
- **THEN** all three notes are selected

#### Scenario: Box then drag
- **WHEN** the user box-selects four notes and then drags one of them two steps to the right
- **THEN** all four notes move two steps to the right

### Requirement: Editing selected notes
The piano roll SHALL show a note inspector whenever at least one note is selected.
- **Contents:** it SHALL show the number of selected notes, their velocity (1–127), and their length in steps. When the selected notes have different values for a property, it SHALL show "Mixed" for that property.
- **Editing:** setting a property SHALL apply the value to every selected note.
  - A length SHALL be shortened for each note as needed, so it does not overlap the next note in its row or pass the end of the grid.
  - On a one-shot instrument the length SHALL be shown but SHALL NOT be editable.
- **Undo:** each committed change SHALL be one undo step.
- **Sound:** changing a property SHALL NOT play the notes.

#### Scenario: Set velocity for many notes
- **WHEN** five notes with different velocities are selected and the user sets velocity to 90 in the inspector
- **THEN** all five notes have velocity 90, and one Cmd/Ctrl+Z restores their previous velocities

#### Scenario: Mixed values
- **WHEN** two selected notes have lengths 2 and 4
- **THEN** the inspector's length shows "Mixed"

### Requirement: Copy, cut, and paste notes
While the piano roll has focus, the user SHALL be able to copy, cut, and paste notes:
- **Copy:** Cmd/Ctrl+C SHALL copy the selected notes, keeping their rows, lengths, velocities, and spacing.
- **Cut:** Cmd/Ctrl+X SHALL copy the selected notes and then remove them, as one undo step.
- **Paste:** Cmd/Ctrl+V SHALL paste the copied notes. The earliest copied note SHALL start at the step under the pointer when the pointer is over the grid. Otherwise it SHALL start at the step right after the end of the most recently copied or pasted notes.

Pasting SHALL follow these rules:
- Pasted notes SHALL keep their rows.
- A pasted note on a row the instrument does not have, or that would start past the end of the grid, SHALL be discarded. A pasted note that would extend past the end of the grid SHALL be shortened.
- A pasted note that starts on the same row and step as an existing note SHALL replace it. An existing note that a pasted note overlaps SHALL be shortened to end where the pasted note starts, and SHALL be removed if nothing of it would remain.
- The pasted notes SHALL become the selection. The paste SHALL be one undo step.
- The page SHALL say how many notes were discarded, if any.

**Scope of the clipboard:** copied notes SHALL remain available across patterns, loops, tracks, and pages in the same browser tab. Keyboard shortcuts in text fields SHALL keep their normal text behavior.

#### Scenario: Copy and paste after
- **WHEN** notes spanning steps 0–15 are selected and copied, and the user presses Cmd/Ctrl+V with the pointer outside the grid
- **THEN** a copy of the notes appears starting at step 16 and is selected, and pressing Cmd/Ctrl+V again places another copy starting at step 32

#### Scenario: Paste at the pointer
- **WHEN** the user copies notes whose earliest note is at step 4, then hovers step 20 and presses Cmd/Ctrl+V
- **THEN** the earliest pasted note is at step 20, and the other notes keep their spacing and rows

#### Scenario: Paste into another track
- **WHEN** the user copies notes from a Piano clip and pastes them into a Strings clip in the Studio
- **THEN** notes whose rows exist on the strings instrument are pasted, and the page says how many notes were discarded

#### Scenario: Cut is undoable
- **WHEN** the user cuts three notes and presses Cmd/Ctrl+Z
- **THEN** the three notes are back where they were

### Requirement: Key highlighting
On the Studio page, a melodic track's piano roll SHALL highlight the rows whose pitch belongs to the song's key (see `songs/multitrack` "Song settings").
- Rows of the key's tonic SHALL be marked distinctly from the other in-key rows. Out-of-key rows SHALL be unhighlighted.
- The highlight SHALL tint both the row label and the row's background, and SHALL NOT make notes harder to see.
- Changing the key SHALL update the highlight immediately.
- Drum tracks and the single-instrument pages SHALL show no key highlighting.

#### Scenario: C major highlight
- **WHEN** the song's key is C major and a Piano clip is open in the dock
- **THEN** the rows for C, D, E, F, G, A, and B are highlighted, the C rows are marked as the tonic, and the sharp rows are not highlighted

#### Scenario: Change key
- **WHEN** the user changes the key from C major to A minor
- **THEN** the same rows stay highlighted, and the tonic marking moves to the A rows
