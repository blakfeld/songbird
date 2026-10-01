## MODIFIED Requirements

### Requirement: Editing a loop in the dock
When a clip is selected and the dock is open, the docked piano roll SHALL edit that clip's loop.
- The grid SHALL be as long as the loop. Its measure numbers SHALL count from 1 at the start of the loop.
- The grid SHALL offer the same display, note editing, selection, clipboard, and resizing behavior as the single-instrument editor (see `patterns/piano-roll-editor`).
- The dock header SHALL show the loop name, the track name, and how many clips use the loop. It SHALL NOT offer a loop length control; a loop's length changes only through its clips, as described in "Moving, resizing, and deleting clips".
- **Playhead:** while the song plays, the dock SHALL show a playhead at the matching position inside the loop whenever the song playhead is within the selected clip, and SHALL hide it otherwise.
- **Nothing selected:** when the selected track has no selected clip, the dock SHALL show an empty state that names the track and offers New clip at the first empty measure. Selecting a track by its header SHALL select that track's earliest clip if the track has one.
- **Closing:** the dock header SHALL offer a Close control with an accessible name. Closing SHALL hide the dock and the resize handle between the arrangement and the dock, and the arrangement SHALL take the freed height. Closing SHALL NOT change the selection, the song, or undo history, and playback SHALL continue.
- **Opening:** while the dock is closed, a single click on a clip SHALL select it without opening the dock. Double-clicking a clip, pressing Enter on a focused clip, or creating a clip by double-clicking an empty lane SHALL select that clip and open the dock on it. When the dock is already open, these actions SHALL behave as before and leave it open.
- **Remembered:** whether the dock is open SHALL be remembered in this browser across reloads and songs. It SHALL NOT be stored in the song or recorded in undo history. The dock SHALL be open the first time the Studio is used. Reopening the dock SHALL restore the height it had before it was closed.

#### Scenario: Loop-local grid
- **WHEN** the user selects a clip at measures 9–12 of a 2-measure loop
- **THEN** the dock shows a 2-measure grid numbered 1–2

#### Scenario: Shorten a loop
- **WHEN** the only clip of a 4-measure loop is shortened to 2 measures on its lane
- **THEN** the dock's grid becomes 2 measures long, and the loop's notes in measures 3–4 are removed

#### Scenario: No loop length field
- **WHEN** a clip is selected
- **THEN** the dock header shows the loop name, track, and clip count, and no length control

#### Scenario: Dock playhead follows repeats
- **WHEN** the selected clip starts at measure 1 and repeats a 2-measure loop four times, and playback reaches measure 5
- **THEN** the dock playhead is at the start of loop measure 1

#### Scenario: Empty track
- **WHEN** the user selects the header of a track that has no clips
- **THEN** the dock shows the empty state with a New clip action instead of a grid

#### Scenario: Close the piano roll
- **WHEN** a clip is selected and the user activates the dock's Close control
- **THEN** the piano roll and its resize handle are hidden, the arrangement fills the freed height, and the clip stays selected

#### Scenario: Single click does not reopen
- **WHEN** the dock is closed and the user clicks a clip once
- **THEN** that clip is selected and the dock stays closed

#### Scenario: Double-click reopens on the clip
- **WHEN** the dock is closed and the user double-clicks a clip of "Groove A"
- **THEN** the dock opens showing "Groove A" in the piano roll, at the height it had before it was closed

#### Scenario: Keyboard reopen
- **WHEN** the dock is closed and the user focuses a clip and presses Enter
- **THEN** the dock opens showing that clip's loop

#### Scenario: Closed state survives reload
- **WHEN** the user closes the dock and reloads the page
- **THEN** the Studio opens with the dock closed

#### Scenario: Closing is not undoable
- **WHEN** the user closes the dock and presses Cmd/Ctrl+Z
- **THEN** the dock stays closed and the most recent song edit is undone instead
