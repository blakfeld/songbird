# Spec Delta

## Purpose

Gives songwriters a web page where they describe a pattern for an instrument, see it on a piano roll, and edit it by hand before playing or exporting it. The Drum Machine page (`/drum-machine`) is this editor with the Drums instrument.

## ADDED Requirements

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
The page SHALL render the current pattern as a grid with one row per instrument row (labelled with its name, in the instrument's order) and one column per step. Measure and beat boundaries SHALL be visually distinct. Each note SHALL be drawn starting at its step and spanning `length_steps` columns, with visual intensity proportional to velocity. Patterns longer than fit on screen SHALL scroll horizontally, with row labels remaining visible.

#### Scenario: Pattern appears after generation
- **WHEN** a generation succeeds
- **THEN** the piano roll shows every note from the returned pattern in its row, starting at its step and spanning its length

#### Scenario: 32-measure pattern is navigable
- **WHEN** a 32-measure pattern is displayed
- **THEN** the user can scroll horizontally to any measure and row labels stay visible

### Requirement: Editing notes
The user SHALL be able to add a note by clicking an empty cell (length 1, velocity 100), remove a note by clicking any cell it covers, and change a note's velocity (1–127) via a velocity control (e.g. drag or modifier-click). Edits SHALL be reflected immediately in the piano roll, playback, and export.

#### Scenario: Add a note
- **WHEN** the user clicks an empty cell in the snare row at step 4
- **THEN** a snare note with length 1 and velocity 100 appears at step 4

#### Scenario: Remove a note
- **WHEN** the user clicks a cell covered by a note
- **THEN** the note is removed

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
The current pattern and prompt SHALL be persisted in the browser, separately per instrument, so that reloading the page restores them. No data SHALL be sent to the server for storage.

#### Scenario: Reload restores pattern
- **WHEN** the user edits a pattern and reloads the page
- **THEN** the same pattern, including edits, is displayed
