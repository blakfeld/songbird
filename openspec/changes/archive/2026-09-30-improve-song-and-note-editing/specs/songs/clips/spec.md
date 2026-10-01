# Spec Delta

## MODIFIED Requirements

### Requirement: Creating and placing clips
The user SHALL be able to add clips on a track's lane in these ways:
- **New clip**: available by double-clicking an empty measure or from the lane's menu. It SHALL create an empty loop named "<track name> <n>", where n is the smallest number not already used by a loop on the track. It SHALL place that loop as a clip starting at that measure. Both the loop and the clip SHALL be 1 measure long.
- **Place loop**: available from the lane's menu on an empty measure. It SHALL list the track's loops and place the chosen loop as a clip at that measure. The clip SHALL be the loop's length, shortened if another clip or the end of the timeline comes sooner.
- **Duplicate**: Cmd/Ctrl+D or the clip's menu. It SHALL place a linked copy of the selected clip directly after it. When the full length does not fit before the next clip or the end of the timeline, it SHALL add nothing and SHALL tell the user why.
- **Alt/Option-drag**: dragging a clip with Alt/Option held SHALL drop a linked copy at the release position and SHALL leave the original in place.

A clip MAY be placed anywhere on the timeline shown in the arrangement (see `songs/multitrack` "Song settings"). A clip that ends after the song's current end SHALL lengthen the song. The new clip SHALL become the selected clip.

#### Scenario: New clip on an empty lane
- **WHEN** the user double-clicks measure 5 of an empty Bass track
- **THEN** a loop "Bass 1" and a 1-measure clip covering measure 5 are created and selected, and the dock shows an empty 1-measure grid

#### Scenario: New clip shortened by a neighbour
- **WHEN** a track has a clip starting at measure 7 and the user double-clicks measure 6
- **THEN** a 1-measure clip covering measure 6 is created, next to the neighbour and not overlapping it

#### Scenario: New clip past the song's end
- **WHEN** a song's clips end at measure 8 and the user double-clicks measure 12 on any lane
- **THEN** a 1-measure clip is created at measure 12, and the song becomes 12 measures long

#### Scenario: Duplicate after
- **WHEN** a 2-measure clip covers measures 1–2 and measures 3–4 are empty, and the user presses Cmd/Ctrl+D
- **THEN** a linked clip of the same loop covers measures 3–4 and is selected

#### Scenario: Duplicate with no room
- **WHEN** a 2-measure clip covers measures 1–2 and another clip starts at measure 3, and the user presses Cmd/Ctrl+D
- **THEN** no clip is added, and the user is told there is no room after the clip

### Requirement: Moving, resizing, and deleting clips
- **Selecting:** clicking a clip SHALL select it. At most one clip SHALL be selected at a time. Selecting a clip SHALL also select its track.
- **Moving:** dragging a clip's body SHALL move it along its own lane in whole measures.
- **Resizing:** dragging a clip's right edge SHALL change its length in whole measures, with a minimum of 1.
  - **A loop only this clip uses:** the loop's length SHALL change with the clip's length. Lengthening SHALL append empty measures to the loop. Shortening SHALL drop the loop's notes that start beyond the new end and SHALL shorten the notes that cross it.
  - **A loop other clips also use:** the loop's length SHALL NOT change. The clip SHALL repeat the loop when it is longer than the loop, and SHALL play only the loop's start when it is shorter.
- **Keyboard:** with a clip focused, Left and Right SHALL move it by one measure, Shift+Left and Shift+Right SHALL shorten or lengthen it by one measure following the same resize rules, and Delete or Backspace SHALL delete it.
- **Limits:** a move or resize SHALL stop at the nearest neighbouring clip, the first measure, or the end of the timeline, rather than overlapping or passing it. Moving or resizing a clip past the song's current end SHALL lengthen the song. Moving, shortening, or deleting the last-ending clip SHALL shorten the song to fit the remaining clips.
- **Loop contents:** apart from resizing a clip whose loop only it uses, moving, resizing, or deleting a clip SHALL NOT change its loop's contents. Deleting a loop's last clip SHALL keep the loop in the track's loop list.

#### Scenario: Move stops at a neighbour
- **WHEN** clips cover measures 1–2 and 5–6, and the user drags the first clip three measures to the right
- **THEN** the first clip covers measures 3–4, next to the second clip, and does not overlap it

#### Scenario: Resizing an unshared clip resizes its loop
- **WHEN** the only clip of a 1-measure loop is dragged by its right edge out to 4 measures
- **THEN** the loop is 4 measures long, measures 2–4 of the loop are empty, and the dock shows a 4-measure grid

#### Scenario: Shrinking an unshared clip drops notes
- **WHEN** the only clip of a 4-measure loop with notes in measure 4 is shortened to 3 measures
- **THEN** the loop is 3 measures long, the measure-4 notes are removed, and one Cmd/Ctrl+Z restores them

#### Scenario: Lengthening a clip repeats the loop
- **WHEN** a 2-measure loop is used by two clips and the user drags the right edge of one of them out to 8 measures
- **THEN** the loop is still 2 measures long, and that clip plays it four times

#### Scenario: Delete keeps the loop
- **WHEN** the user deletes the only clip of the loop "Chorus keys"
- **THEN** the lane no longer shows that clip, and "Chorus keys" is still offered by Place loop

### Requirement: Editing a loop in the dock
When a clip is selected, the docked piano roll SHALL edit that clip's loop.
- The grid SHALL be as long as the loop. Its measure numbers SHALL count from 1 at the start of the loop.
- The grid SHALL offer the same display, note editing, selection, clipboard, and resizing behavior as the single-instrument editor (see `patterns/piano-roll-editor`).
- The dock header SHALL show the loop name, the track name, and how many clips use the loop. It SHALL NOT offer a loop length control; a loop's length changes only through its clips, as described in "Moving, resizing, and deleting clips".
- **Playhead:** while the song plays, the dock SHALL show a playhead at the matching position inside the loop whenever the song playhead is within the selected clip, and SHALL hide it otherwise.
- **Nothing selected:** when the selected track has no selected clip, the dock SHALL show an empty state that names the track and offers New clip at the first empty measure. Selecting a track by its header SHALL select that track's earliest clip if the track has one.

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
