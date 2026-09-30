# Spec Delta

## MODIFIED Requirements

### Requirement: Piano-roll display
The page SHALL render the current pattern as a grid with one row per instrument row, in the instrument's order, and one column per step. Measure and beat boundaries SHALL be visually distinct. Each note SHALL be drawn starting at its step and spanning `length_steps` columns, with visual intensity proportional to velocity. Patterns longer than fit on screen SHALL scroll horizontally, with row labels remaining visible.

For a drums instrument each row SHALL be labelled with its name.

For a melodic instrument:
- The row labels SHALL form a vertical piano keyboard, with white and black keys drawn by pitch.
- Every C row SHALL show its visible name (for example `C4`).
- Every row SHALL expose its pitch name as its accessible label.
- Black-key rows SHALL be shaded differently from white-key rows across the grid.
- When the rows do not fit vertically, the grid SHALL scroll vertically while the keyboard and measure ruler stay visible.
- When a melodic pattern is first shown, the grid SHALL be scrolled vertically so the pattern's notes are in view. For an empty pattern it SHALL show the `C4` row.

#### Scenario: Pattern appears after generation
- **WHEN** a generation succeeds
- **THEN** the piano roll shows every note from the returned pattern in its row, starting at its step and spanning its length

#### Scenario: 32-measure pattern is navigable
- **WHEN** a 32-measure pattern is displayed
- **THEN** the user can scroll horizontally to any measure and row labels stay visible

#### Scenario: Piano rows read as a keyboard
- **WHEN** a piano pattern is displayed
- **THEN** the row gutter shows a keyboard from C7 at the top to C2 at the bottom, only C rows show a visible label, the `C#4` row is shaded as a black key, and every row's accessible label is its pitch name

#### Scenario: Vertical navigation keeps keys visible
- **WHEN** the user scrolls a piano pattern vertically to the `C2` row
- **THEN** the `C2` key remains labelled and the measure ruler stays visible

#### Scenario: Opening scrolls to the notes
- **WHEN** a piano pattern whose notes are all between `C5` and `G5` is loaded
- **THEN** the rows `C5` through `G5` are within the visible area without the user scrolling

#### Scenario: Empty melodic pattern shows middle C
- **WHEN** the user creates a new empty piano pattern
- **THEN** the `C4` row is within the visible area

### Requirement: Editing notes
The user SHALL be able to add a note by clicking an empty cell, remove a note by clicking any cell it covers, and change a note's velocity (1–127) with a velocity control (for example drag or modifier-click).

A new note SHALL have velocity 100. Its length SHALL be:
- 1 step for a one-shot instrument;
- one beat for a sustained instrument, which is 4 steps in 4/4 and 3/4 and 6 steps in 6/8. This length SHALL be shortened so it ends before the next note in the same row and within the pattern.

Edits SHALL be reflected immediately in the piano roll, playback, and export.

#### Scenario: Add a note
- **WHEN** the user clicks an empty cell in the snare row at step 4
- **THEN** a snare note with length 1 and velocity 100 appears at step 4

#### Scenario: Add a sustained note
- **WHEN** the user clicks an empty cell in the `E4` row of a 4/4 piano pattern at step 0
- **THEN** an `E4` note with length 4 and velocity 100 appears at step 0

#### Scenario: Sustained default is clipped by the next note
- **WHEN** a 4/4 piano pattern has an `E4` note at step 2 and the user clicks the empty `E4` cell at step 0
- **THEN** a note with length 2 appears at step 0

#### Scenario: Remove a note
- **WHEN** the user clicks a cell covered by a note
- **THEN** the note is removed

#### Scenario: Edit velocity
- **WHEN** the user sets a note's velocity to 40
- **THEN** the note is drawn at reduced intensity and plays and exports with velocity 40

## ADDED Requirements

### Requirement: Instrument pages
The application SHALL provide an editor page at `/instruments/<id>` for every instrument listed by `GET /api/v1/instruments`. That page SHALL be the pattern editor with that instrument, titled with the instrument's name. The Drum Machine SHALL remain at `/drum-machine`, and `/instruments/drums` SHALL redirect to it. A page for an id the service does not list SHALL show a not-found message with a link back to the landing page. The landing page (`/`) SHALL link to the editor page of every listed instrument.

#### Scenario: Piano page
- **WHEN** the user opens `/instruments/piano`
- **THEN** the pattern editor titled "Piano" is shown, and clicking Generate requests the `piano` instrument

#### Scenario: Drums alias
- **WHEN** the user opens `/instruments/drums`
- **THEN** they are redirected to `/drum-machine`

#### Scenario: Unknown instrument page
- **WHEN** the user opens `/instruments/kazoo`
- **THEN** a not-found message is shown with a link to `/`, and no generation request can be made

#### Scenario: Instruments unavailable
- **WHEN** the user opens `/instruments/piano` and the instrument list cannot be loaded
- **THEN** an error with a Retry control is shown instead of the not-found message, and retrying after the service recovers shows the Piano editor

#### Scenario: Landing page lists instruments
- **WHEN** the service lists `drums` and `piano` and the user opens `/`
- **THEN** the page links to `/drum-machine` and `/instruments/piano`

#### Scenario: Work is kept per instrument
- **WHEN** the user edits a piano pattern, opens the Drum Machine, and returns to `/instruments/piano`
- **THEN** the piano pattern, including the edits, is displayed and the drum pattern is unaffected

### Requirement: Pitch audition
On a melodic instrument's page, clicking or activating a key in the keyboard gutter SHALL play that pitch briefly, about half a second at velocity 100, with the instrument's sound. This SHALL NOT change the pattern or the undo history.

#### Scenario: Audition a key
- **WHEN** the user clicks the `A4` key on the piano page
- **THEN** A4 sounds briefly and the pattern and undo history are unchanged
