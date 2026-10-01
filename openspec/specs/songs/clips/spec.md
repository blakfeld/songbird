# songs/clips Specification

## Purpose

Lets songwriters build each track from reusable loops placed as clips on the song timeline, so a part is written once, repeated anywhere, and changed everywhere with a single edit.

## Requirements

### Requirement: Loops and clips
Each track SHALL hold a list of loops and a list of clips.
- Each loop SHALL have:
  - an `id` unique within the song;
  - a `name` of 1–40 characters;
  - `measures`, an integer from 1 to 128;
  - `notes` in the pattern note shape, where `step` is counted from the start of the loop and `row_id` is a row of the track's instrument.
- No loop note SHALL extend past the end of its loop, and no two notes in the same row of a loop SHALL overlap.
- Each clip SHALL have an `id` unique within the song, a `loop_id` naming a loop of the same track, a `start_measure` (1-based), and `measures` (an integer of at least 1).
- Every clip SHALL lie entirely within the song, and no two clips on the same track SHALL overlap.
- A track SHALL hold at most 64 loops and at most 256 clips. Any action that would exceed a limit SHALL be refused, and the user SHALL be told why.
- A loop MAY have no clips. It then stays in the track's loop list until it is deleted.

#### Scenario: Clip references its own track's loop
- **WHEN** a song is loaded with a clip whose `loop_id` names a loop on a different track
- **THEN** that song fails validation on load, and the user is told it could not be opened

#### Scenario: Clip limit
- **WHEN** a track has 256 clips and the user tries to duplicate one of them
- **THEN** no clip is added, and the user is told the track has reached its clip limit

### Requirement: What a clip plays
A clip SHALL play its loop starting at the clip's `start_measure`.
- When the clip is longer than the loop, the loop SHALL repeat back to back until the clip ends.
- When the clip is shorter than the loop, only the loop's first `measures` measures SHALL play.
- A note SHALL play when it starts inside the clip. A note that would sound past the clip's end SHALL be cut off at the clip's end.
- Everything outside clips SHALL be silent.
- Song playback, the song loop range, mute, solo, and the other mixer controls SHALL treat these notes exactly as `songs/multitrack` treats track notes.

#### Scenario: A clip repeats its loop
- **WHEN** a 2-measure loop has a kick on its first step and is placed as a clip starting at measure 3 with a length of 6 measures
- **THEN** the kick plays at the start of measures 3, 5, and 7, and nowhere else on that track

#### Scenario: A short clip plays the start of its loop
- **WHEN** a 4-measure loop is placed as a 1-measure clip
- **THEN** only the loop's first measure plays

#### Scenario: A note is cut at the clip end
- **WHEN** a sustained note starts in the last measure of a clip and is 2 measures long
- **THEN** the note stops sounding at the end of the clip

### Requirement: Linked clips and make unique
Every clip of a loop SHALL play that loop's current contents, so an edit to the loop SHALL change every clip that uses it.
- Each clip SHALL offer **Make unique**, available only when its loop is used by more than one clip. Make unique SHALL give that clip a new copy of the loop, with the same notes and length and the name "<loop name> (copy)", and SHALL leave the other clips unchanged.
- Renaming a loop SHALL rename it for every clip that uses it.

#### Scenario: Edit once, change everywhere
- **WHEN** the loop "Groove A" is placed at measures 1, 3, and 5, and the user adds a snare to it while the clip at measure 3 is selected
- **THEN** the snare plays in all three clips

#### Scenario: Make one clip unique
- **WHEN** the user makes the clip at measure 5 unique and then removes its snare
- **THEN** the clips at measures 1 and 3 still play the snare, and the clip at measure 5 plays "Groove A (copy)" without it

#### Scenario: Make unique unavailable for a single clip
- **WHEN** a loop is used by exactly one clip
- **THEN** that clip's Make unique action is disabled

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

### Requirement: Managing a track's loops
The editor dock SHALL show a loop menu for the selected track. It SHALL list every loop on the track with the number of clips that use it, and SHALL let the user rename a loop and delete a loop. Deleting a loop SHALL also delete every clip that uses it.

#### Scenario: Delete a placed loop
- **WHEN** the loop "Fill" is used by 3 clips and the user deletes it from the loop menu
- **THEN** "Fill" and its 3 clips are removed, and a single undo restores all of them

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

### Requirement: Clips in the lane overview
Each lane SHALL draw every clip as a separate block at its position on the song timeline.
- Each block SHALL show the loop name and, in miniature, the notes the clip plays, with a visible mark at each point where the loop repeats.
- The selected clip SHALL be visibly distinguished.
- Clips of the same loop SHALL share a visual marker, distinct from the markers of other loops on the track, so linked placements can be seen at a glance.
- Empty lanes SHALL show a hint that double-clicking adds a clip.
- Each clip SHALL be keyboard-focusable. Its accessible name SHALL include the loop name, the measure span, and, when it is linked, the number of clips that share the loop.
- Edits to a loop SHALL be reflected immediately in every block that shows it.

#### Scenario: Linked clips look linked
- **WHEN** a track has two clips of "Groove A" and one of "Fill"
- **THEN** both "Groove A" blocks share one marker, and the "Fill" block has a different one

#### Scenario: Accessible clip name
- **WHEN** a screen-reader user focuses a clip of "Groove A" covering measures 3–4, where "Groove A" is used by 3 clips
- **THEN** the clip is announced with "Groove A", "measures 3 to 4", and "linked, 3 clips"

### Requirement: Loading songs saved before clips
A song saved with document `version` 1 SHALL be converted when it is opened:
- A track with notes SHALL get one loop that spans the whole song, holding those notes at the same positions. That loop SHALL be named after the track and placed as one clip covering the whole song.
- A track without notes SHALL get no loops and no clips.
- The converted song SHALL play exactly as it did before conversion, and SHALL be saved as `version` 2 on the next save.

#### Scenario: Old song converts without audible change
- **WHEN** the user opens a 16-measure version 1 song whose Drums track has notes and whose Keys track is empty
- **THEN** Drums has one loop "Drums" placed as one clip covering measures 1–16 with the same notes, Keys has no clips, and playback sounds the same as before

### Requirement: Undo for clip and loop actions
Undo and redo on the Studio page SHALL cover:
- creating, placing, duplicating, moving, resizing, and deleting clips;
- Make unique;
- renaming, resizing, and deleting loops;
- note edits inside a loop.

A single drag SHALL be recorded as one undo step. Selecting a clip SHALL NOT be recorded.

#### Scenario: Undo a move
- **WHEN** the user drags a clip from measure 1 to measure 5 in one gesture and presses Cmd/Ctrl+Z
- **THEN** the clip is back at measure 1

#### Scenario: Undo make unique
- **WHEN** the user makes a clip unique and then presses Cmd/Ctrl+Z
- **THEN** the clip uses the original shared loop again, and the copy no longer exists
