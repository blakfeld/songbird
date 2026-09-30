# Spec Delta

## ADDED Requirements

### Requirement: Send pattern to a song
Each single-instrument editor page SHALL offer a "Send to song" action whenever a pattern is displayed. The action SHALL let the user choose a new song or an existing song whose time signature matches the pattern's. It SHALL add a new track using the page's instrument, named after the pattern, containing the pattern's notes starting at measure 1. If the pattern is longer than the chosen song, the song SHALL be lengthened to the pattern's length. A new song SHALL take the pattern's tempo, time signature, and swing. The action SHALL be unavailable for a song that already has 16 tracks, and SHALL NOT change the pattern on the editor page.

#### Scenario: Send a drum pattern to a new song
- **WHEN** the user on the Drum Machine page sends an 8-measure 4/4 pattern named "Boom Bap" at 90 BPM to a new song
- **THEN** a new song at 90 BPM in 4/4 exists with 8 measures and one Drums track named "Boom Bap" containing the pattern's notes

#### Scenario: Mismatched time signature is not offered
- **WHEN** the pattern is in 3/4 and the user opens the song chooser
- **THEN** only songs in 3/4, plus the option to create a new song, are offered

#### Scenario: Song lengthened to fit
- **WHEN** a 16-measure pattern is sent to an existing 8-measure song
- **THEN** the song becomes 16 measures, and its existing tracks are empty in measures 9–16

### Requirement: Placing a note previews it
When the user adds a note by clicking an empty cell in a piano roll, the page SHALL immediately play that note once, with the row's sound, at the new note's velocity, whether or not playback is running. Removing a note, resizing it, and changing its velocity SHALL NOT play it. This applies to the single-instrument editor pages and to the Studio piano roll. On the Studio, the preview SHALL use the selected track's instrument, volume, and pan, and SHALL be heard even when that track is muted or another track is soloed, so that the user always hears the note they placed.

#### Scenario: Place a note on the Drum Machine
- **WHEN** the user clicks an empty cell in the Kick row
- **THEN** a kick sound plays once and a kick note is added

#### Scenario: Place a note on a Studio track
- **WHEN** the Bass track is selected, panned hard left, and the user clicks an empty cell in row `C2`
- **THEN** a bass `C2` plays once, heard only in the left channel

### Requirement: Drag a note to another row
The user SHALL be able to move a note to another row by dragging it up or down in a piano roll. The note SHALL follow the pointer row by row and keep its start step, length, and velocity. Each time the note enters a new row, that row's sound SHALL play once at the note's velocity. A row where the note would overlap another note SHALL be skipped, and the note SHALL stay in the last row where it fit. A whole drag SHALL be recorded as one undo step, and a drag that ends in the starting row SHALL NOT be recorded. With a note focused, Alt+Up and Alt+Down SHALL move it one row up or down, with the same overlap rule. This applies to the single-instrument editor pages and to the Studio piano roll. On the Studio, the preview SHALL follow the rules of "Placing a note previews it".

#### Scenario: Drag a note up two semitones
- **WHEN** the user drags a `C4` note at step 8 upward by two rows
- **THEN** the note is a `D4` at step 8 with its length and velocity unchanged, `C#4` and `D4` each played once during the drag, and one Cmd/Ctrl+Z returns it to `C4`

#### Scenario: Occupied row is skipped
- **WHEN** the user drags a note onto a row that already has a note overlapping its steps and releases there
- **THEN** the note stays in the nearest row it passed through where it fit, and the other note is unchanged

### Requirement: Resize the piano roll vertically
The user SHALL be able to change the height of the piano roll by dragging a resize handle. On the single-instrument editor pages, the handle SHALL sit on the bottom edge of the piano roll. On the Studio, the handle SHALL sit between the arrangement and the editor dock, and it SHALL trade height between them. The handle SHALL be a keyboard-operable separator: Up and Down change the height in steps, and double-clicking resets the default height. Each region SHALL keep a usable minimum height. The chosen height SHALL be remembered in this browser separately for each page, and SHALL NOT be recorded in undo history.

#### Scenario: Enlarge the Studio dock
- **WHEN** the user drags the handle between the arrangement and the dock upward
- **THEN** the dock grows and the arrangement shrinks by the same amount, neither drops below its minimum height, and the size is kept after a reload

### Requirement: Shift-drag a note to change its velocity
Holding Shift while dragging a note vertically SHALL change that note's velocity (1–127) instead of its row, showing the value on the note while dragging. The note's start step, length, and row SHALL be unchanged. A whole drag SHALL be one undo step, and velocity changes SHALL NOT play the note. The note's tooltip SHALL say that Shift-drag changes velocity. This applies to the single-instrument editor pages and to the Studio piano roll.

#### Scenario: Plain vertical drag changes pitch, Shift drag changes velocity
- **WHEN** the user drags a note upward without Shift, and then drags it upward holding Shift
- **THEN** the first drag moves the note to a higher row, and the second raises its velocity without moving it
