# patterns/piano-roll-editor Specification

## Purpose

Gives songwriters a web page where they describe a pattern for an instrument, see it on a piano roll, and edit it by hand before playing or exporting it. The Drum Machine page (`/drum-machine`) is this editor with the Drums instrument.

## Requirements

### Requirement: Prompt and parameter form
The editor page SHALL provide a text input for the description, a measure selector offering exactly 4, 8, 12, 16, and 32 (default 4), a tempo input (40–240 BPM, optional — blank means "let the AI choose"), a time-signature selector (4/4, 3/4, 6/8; default 4/4), and a Generate button. Generation SHALL request the page's instrument.

#### Scenario: Measure options
- **WHEN** the user opens the measure selector
- **THEN** exactly the options 4, 8, 12, 16, and 32 are offered

#### Scenario: Generate disabled for empty prompt
- **WHEN** the prompt field is empty or whitespace
- **THEN** the Generate button is disabled

#### Scenario: Drum Machine requests drums
- **WHEN** the user clicks Generate on the Drum Machine page
- **THEN** the generation request names the `drums` instrument

### Requirement: Prompt token counter
The prompt form SHALL display a live estimated token count against the service's `max_input_tokens` (e.g. "123 / 256"), obtained from the generation limits endpoint and computed with the same estimation rule as the service. When the estimate exceeds the limit, the counter SHALL be visually flagged and Generate SHALL be disabled.

#### Scenario: Counter updates while typing
- **WHEN** the user types a 40-character description and the limit is 256
- **THEN** the counter shows "10 / 256"

#### Scenario: Over the limit
- **WHEN** the description's estimate exceeds the limit
- **THEN** the counter is flagged as over the limit and the Generate button is disabled

### Requirement: Generation progress and errors
While a generation request is in flight the page SHALL show a loading state and disable Generate. If generation fails, the page SHALL show the error message and keep the previously displayed pattern unchanged.

#### Scenario: Failed generation keeps existing work
- **WHEN** a pattern is displayed and a new generation returns an error
- **THEN** an error message is shown and the displayed pattern is unchanged

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

### Requirement: Resizing notes
The user SHALL be able to change a note's length by dragging its right edge, in whole steps, with a minimum of 1. A note SHALL NOT be lengthened past the start of the next note in the same row or past the end of the pattern.

#### Scenario: Lengthen a note
- **WHEN** the user drags the right edge of a length-1 note at step 0 to the end of step 3
- **THEN** the note has `length_steps` 4 and is drawn across steps 0–3

#### Scenario: Resize stops at the next note
- **WHEN** a row has notes at steps 0 and 4 and the user drags the first note's right edge to step 7
- **THEN** the first note's `length_steps` is 4

### Requirement: Undo and redo
The editor SHALL support undo and redo of note edits (including resizes) and parameter changes, via on-screen buttons and the keyboard shortcuts Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z.

#### Scenario: Undo a removal
- **WHEN** the user removes a note and then presses Cmd/Ctrl+Z
- **THEN** the note is restored

### Requirement: Changing pattern length after generation
The user SHALL be able to change the measure count of the current pattern to any of 4, 8, 12, 16, or 32 without regenerating. Lengthening SHALL repeat the existing measures in order to fill the new length; shortening SHALL drop notes starting beyond the new end and shorten notes that cross it.

#### Scenario: Lengthen 4 to 8
- **WHEN** a 4-measure pattern is changed to 8 measures
- **THEN** measures 5–8 contain the same notes as measures 1–4

#### Scenario: Shorten 8 to 4
- **WHEN** an 8-measure pattern is changed to 4 measures
- **THEN** only notes starting in measures 1–4 remain, and none extends past measure 4

### Requirement: Editing tempo and swing
The user SHALL be able to change tempo (40–240 BPM) and swing (0–75%) of the current pattern without regenerating.

#### Scenario: Change tempo
- **WHEN** the user sets tempo to 120
- **THEN** playback and export both use 120 BPM

### Requirement: Clearing and starting blank
The user SHALL be able to start from an empty pattern for the page's instrument (no generation) and to clear all notes from the current pattern.

#### Scenario: Program from scratch
- **WHEN** the user chooses "New empty pattern" with 8 measures on the Drum Machine page
- **THEN** an empty 8-measure grid with the drums instrument's rows is shown and can be edited

### Requirement: Work survives page reload
The current pattern and prompt SHALL be persisted in the browser, separately per signed-in user and per instrument, so that reloading the page restores them. No pattern data SHALL be sent to the server for storage. A user SHALL never see a pattern saved by another user in the same browser. Logging out, or being signed out after a `401`, SHALL delete every saved pattern and prompt from the browser, along with the rest of the user's browser storage (see `platform/accounts`, "Per-user browser storage").

#### Scenario: Reload restores pattern
- **WHEN** the user edits a pattern and reloads the page
- **THEN** the same pattern, including edits, is displayed

#### Scenario: Patterns are not shared between users
- **WHEN** user A edits a piano pattern, logs out, and user B signs in on the same browser and opens the piano page
- **THEN** user B sees an empty piano pattern, not user A's

#### Scenario: Logout clears patterns
- **WHEN** a user logs out
- **THEN** no pattern or prompt saved by the editor pages remains in browser storage

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

### Requirement: Send pattern to a song
Each single-instrument editor page SHALL offer a "Send to song" action whenever a pattern is displayed.
- **Choosing a song:** the action SHALL let the user choose a new song, or an existing song whose time signature matches the pattern's.
- **What is added:** the action SHALL add a new track that uses the page's instrument and is named after the pattern. The track SHALL have one loop, named after the pattern, holding the pattern's notes and as long as the pattern. That loop SHALL be placed as one clip starting at measure 1 and as long as the pattern.
- **Song length:** if the pattern is longer than the chosen song, the song SHALL be lengthened to the pattern's length.
- **New song settings:** a new song SHALL take the pattern's tempo, time signature, and swing.
- **Availability:** the action SHALL be unavailable for a song that already has 16 tracks.
- **The source pattern:** the action SHALL NOT change the pattern on the editor page.

#### Scenario: Send a drum pattern to a new song
- **WHEN** the user on the Drum Machine page sends an 8-measure 4/4 pattern named "Boom Bap" at 90 BPM to a new song
- **THEN** a new song at 90 BPM in 4/4 exists with 8 measures
- **AND** it has one Drums track named "Boom Bap", whose loop "Boom Bap" holds the pattern's notes and is placed as one clip covering measures 1–8

#### Scenario: Mismatched time signature is not offered
- **WHEN** the pattern is in 3/4 and the user opens the song chooser
- **THEN** only songs in 3/4, plus the option to create a new song, are offered

#### Scenario: Song lengthened to fit
- **WHEN** a 16-measure pattern is sent to an existing 8-measure song
- **THEN** the song becomes 16 measures, and its existing tracks have no clips in measures 9–16

#### Scenario: Short pattern into a longer song
- **WHEN** a 2-measure pattern is sent to an existing 16-measure song
- **THEN** the new track has one 2-measure clip covering measures 1–2, and the song stays 16 measures long

### Requirement: Placing a note previews it
When the user adds a note by clicking an empty cell in a piano roll, the page SHALL immediately play that note once, with the row's sound, at the new note's velocity, whether or not playback is running. Removing a note, resizing it, and changing its velocity SHALL NOT play it. This applies to the single-instrument editor pages and to the Studio piano roll. On the Studio, the preview SHALL use the selected track's instrument, volume, and pan, and SHALL be heard even when that track is muted or another track is soloed, so that the user always hears the note they placed.

#### Scenario: Place a note on the Drum Machine
- **WHEN** the user clicks an empty cell in the Kick row
- **THEN** a kick sound plays once and a kick note is added

#### Scenario: Place a note on a Studio track
- **WHEN** the Bass track is selected, panned hard left, and the user clicks an empty cell in row `C2`
- **THEN** a bass `C2` plays once, heard only in the left channel

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

### Requirement: Resize the piano roll vertically
The user SHALL be able to change the height of the piano roll by dragging a resize handle. On the single-instrument editor pages, the handle SHALL sit on the bottom edge of the piano roll. On the Studio, the handle SHALL sit between the arrangement and the editor dock, and it SHALL trade height between them. The handle SHALL be a keyboard-operable separator: Up and Down change the height in steps, and double-clicking resets the default height. Each region SHALL keep a usable minimum height. The chosen height SHALL be remembered in this browser separately for each page, and SHALL NOT be recorded in undo history.

#### Scenario: Enlarge the Studio dock
- **WHEN** the user drags the handle between the arrangement and the dock upward
- **THEN** the dock grows and the arrangement shrinks by the same amount, neither drops below its minimum height, and the size is kept after a reload

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
