# songs/multitrack Specification

## Purpose

Lets songwriters build a song from several instrument tracks on one shared timeline, edit each track on the piano roll, balance them with volume, pan, mute, and solo, and hear them played together in the browser.

## Requirements

### Requirement: Song document
A song SHALL have:
- a `version` of `2`;
- an `id`;
- a `name` of 1–80 characters;
- `tempo_bpm`, from 40 to 240;
- `time_signature`, one of `"4/4"`, `"3/4"`, or `"6/8"`;
- `swing`, from 0.0 to 0.75;
- a `key`, with a `tonic` (one of `C`, `C#`, `D`, `D#`, `E`, `F`, `F#`, `G`, `G#`, `A`, `A#`, `B`) and a `mode` (`major` or `minor`);
- `measures`, an integer from 1 to 128;
- an ordered list of 0–16 `tracks`.

`measures` SHALL always equal the end measure of the song's last-ending clip on any track, or 1 when the song has no clips. A song saved without a `key` SHALL open in C major, and a song saved with a stale `measures` SHALL be corrected when it opens.

Step resolution and `steps_per_measure` SHALL follow the same sixteenth-note rules as a pattern document.

Each track SHALL have:
- an `id`;
- a `name` of 1–40 characters;
- an `instrument`, which is an instrument id listed by `GET /api/v1/instruments`;
- `volume_db`, from −60.0 to +6.0;
- `pan`, from −1.0 (full left) to +1.0 (full right);
- `muted` and `soloed` flags;
- `loops` and `clips`, as defined by `songs/clips`.

Every note in a track's loops SHALL reference a row of the track's instrument.

Every place that checks a song document, including the browser song library, project-file import, and server-side song validation, SHALL accept a song with no tracks.

#### Scenario: New song defaults
- **WHEN** the user creates a new song, or opens the Studio for the first time with no saved songs
- **THEN** it has these settings:
  - It is named "Untitled song".
  - It is in 4/4 and C major, at 120 BPM with swing 0.
  - It has no clips, so it is 1 measure long.
  - It has no tracks.

#### Scenario: Existing songs keep their tracks
- **WHEN** the user opens a song saved with Drums and Piano tracks before this change
- **THEN** it opens with the same Drums and Piano tracks

#### Scenario: Server accepts a song with no tracks
- **WHEN** a client posts a song with no tracks to the song chat endpoint
- **THEN** the song is not rejected for its track count

#### Scenario: Rows come from the track's instrument
- **WHEN** a track uses the `drums` instrument
- **THEN** its piano roll shows exactly the drums instrument's rows, and every note in the track's loops references one of them

#### Scenario: Length follows the clips
- **WHEN** a song's last-ending clip covers measures 9–12 and the user deletes it, leaving clips that end at measure 6
- **THEN** the song is 6 measures long

#### Scenario: Old song without a key
- **WHEN** the user opens a song saved before keys existed
- **THEN** its key is C major and its notes are unchanged

### Requirement: Adding, renaming, and deleting tracks
The Studio page SHALL let the user add a track by choosing an instrument from those listed by `GET /api/v1/instruments`, rename a track, and delete a track. Each track SHALL have exactly one instrument, which SHALL NOT change after the track is created. The same instrument MAY be used by several tracks. The Add Track control SHALL be disabled when the song has 16 tracks. Every track, including the only remaining track, SHALL be deletable.

The Add Track control SHALL have visible spacing on every side, so it does not touch the edges of the arrangement header cell that holds it or the track counter beside it, at both desktop and narrow widths.

#### Scenario: Add a second piano track
- **WHEN** a song already has a Piano track and the user adds another track choosing `piano`
- **THEN** the song has two independent piano tracks whose notes can be edited separately

#### Scenario: Track limit
- **WHEN** a song has 16 tracks
- **THEN** the Add Track control is disabled

#### Scenario: Delete the last track
- **WHEN** a song has exactly one track and the user deletes it
- **THEN** the song has no tracks and the Studio shows the empty arrangement

#### Scenario: Undo deleting the last track
- **WHEN** the user deletes a song's only track and presses Cmd/Ctrl+Z
- **THEN** the track is restored with its loops, clips, and mixer values

### Requirement: Reorder tracks
The Studio page SHALL let the user move a track to any position in the song's track order. The track SHALL keep its id, name, instrument, mixer and sound settings, loops, and clips. The other tracks SHALL keep their relative order.
- **Drag:** each track header SHALL have a drag handle. While the user drags it vertically, the page SHALL show where the track will land. Dropping it SHALL move the track there. Pressing Escape during the drag, or dropping where it started, SHALL leave the order unchanged.
- **Menu:** the track options menu SHALL offer "Move track up" and "Move track down". "Move track up" SHALL be disabled for the first track, and "Move track down" for the last.
- **Keyboard:** with focus on a track header's select control, Alt+Shift+Up and Alt+Shift+Down SHALL move the track one position, and focus SHALL stay on that track's header.
- **Announcement:** after each move, assistive technology SHALL be told the track's name and its new position out of the total, for example "Bass moved to position 2 of 4".
- **Undo:** each completed move SHALL be one undo step. A drag that ends where it started, or a move that can't happen, SHALL NOT add an undo step.
- **Effects of order:** track numbers, lane order, the order of tracks in exported MIDI and project files, MIDI channel assignment, and the generation-context trimming order SHALL all follow the new order. These requirements are already defined in terms of track order.
- The selected track and clip, the open editor dock, and playback SHALL NOT be interrupted by a move.

#### Scenario: Drag a track up
- **WHEN** a song has tracks Drums, Piano, and Bass, and the user drags Bass's handle above Piano and drops it
- **THEN** the order is Drums, Bass, Piano, and Bass is shown as track 2

#### Scenario: Cancel a drag
- **WHEN** the user drags Bass above Drums and presses Escape before dropping
- **THEN** the order is unchanged, and no undo step is added

#### Scenario: Move from the menu
- **WHEN** the user chooses "Move track down" in the Drums track's options menu in a song with tracks Drums, Piano, and Bass
- **THEN** the order is Piano, Drums, Bass

#### Scenario: Ends of the list
- **WHEN** the user opens the options menu of the first track
- **THEN** "Move track up" is disabled, and "Move track down" is enabled if there is more than one track

#### Scenario: Keyboard move keeps focus
- **WHEN** focus is on the Piano header in a song with tracks Drums, Piano, and Bass, and the user presses Alt+Shift+Down
- **THEN** the order is Drums, Bass, Piano, focus stays on the Piano header, and "Piano moved to position 3 of 3" is announced

#### Scenario: Undo a move
- **WHEN** the user moves Bass from position 3 to position 1 and presses Cmd/Ctrl+Z
- **THEN** Bass is at position 3 again, and the other tracks are in their original order

#### Scenario: Export follows the new order
- **WHEN** a song with melodic tracks Keys and then Bass is reordered to Bass then Keys and exported to MIDI
- **THEN** the file lists Bass before Keys, with Bass on channel 1 and Keys on channel 2

#### Scenario: Reorder while playing
- **WHEN** the song is playing and the user moves a track
- **THEN** playback continues without interruption, and every track still sounds the same

### Requirement: Song settings
The user SHALL be able to change these song settings from the Studio header:
- the name;
- the tempo, from 40 to 240 BPM;
- the swing, from 0 to 75%;
- the time signature;
- the key.

There SHALL be no control for the song's length, which follows its clips (see "Song document").

**The timeline:** the arrangement SHALL show at least 8 empty measures after the song's end and at least 16 measures in total, never more than 128.

**Changing the time signature:** the timeline and every piano roll SHALL regrid to the new measure length. Clips SHALL keep their start measures and lengths in measures. Each loop note SHALL keep its measure and its step within that measure.
- A note whose step within its measure does not exist in the new, shorter measure SHALL be removed.
- A note SHALL keep its length, and MAY cross a barline. Its length SHALL be shortened only to end at the next note in its row or at the end of its loop.
- **Confirmation:** when any notes would be removed, the page SHALL first say how many, and SHALL change the time signature only if the user confirms.
- **Undo:** the change SHALL be one undo step.
- **Tempo:** tempo SHALL NOT change.

**Changing the key:** a key change SHALL NOT change any note.

Changes to the time signature and the key SHALL be song setting changes for undo purposes.

#### Scenario: Lengthen appends silence
- **WHEN** an 8-measure song's Bass clip is moved so it ends at measure 12
- **THEN** the song is 12 measures long, measures 9–12 of the other tracks have no clips, and their measures 1–8 are unchanged

#### Scenario: Shorten trims clips
- **WHEN** a 12-measure song's only clip reaching past measure 8 is deleted
- **THEN** the song shortens to the end of its last remaining clip, and no other clip or loop changes

#### Scenario: Timeline room past the end
- **WHEN** a song's clips end at measure 20
- **THEN** the arrangement shows measures 1–28, and the user can create a clip in measure 25, which makes the song 25 measures long

#### Scenario: 4/4 to 3/4 keeps beats in their bars
- **WHEN** a 4/4 loop has notes on the first step of beats 1, 2, and 4 of measure 2, and the user changes the song to 3/4 and confirms
- **THEN** the notes on beats 1 and 2 of measure 2 remain on beats 1 and 2 of measure 2, the beat-4 note is removed, and the page had said one note would be removed

#### Scenario: Cancel a lossy change
- **WHEN** a change to 3/4 would remove notes and the user cancels the warning
- **THEN** the song stays in 4/4 and every note is unchanged

#### Scenario: Lengthening the measure loses nothing
- **WHEN** a 3/4 song is changed to 4/4
- **THEN** no warning is shown, every note keeps its measure and step within the measure, and the last beat of every measure is empty

#### Scenario: A sustained note keeps its length across barlines
- **WHEN** a loop has a note longer than one measure and the user changes the time signature
- **THEN** the note keeps its length, shortened only if it would run into the next note in its row or past the loop's end

#### Scenario: Undo a key change
- **WHEN** the user changes the key from C major to E minor and presses Cmd/Ctrl+Z
- **THEN** the key is C major again

### Requirement: Arrangement overview and track editing
The Studio page SHALL show one lane per track, in track order, on a shared measure timeline with measure numbers.
- **Lanes:** each lane SHALL have a header and a timeline area. The header SHALL show the track's number, name, instrument, and mixer controls. The timeline area SHALL show the track's clips as described in `songs/clips`.
- **Editing:** selecting a clip SHALL make its loop the one shown in the piano roll docked below the arrangement, as described in `songs/clips`, using the track's instrument rows. Whether the dock is open is described in `songs/clips`, "Editing a loop in the dock".
- **Updates:** edits SHALL be reflected immediately in the lane overview, in playback, and in saved state.
- **No tracks:** when the song has no tracks, the arrangement SHALL show the measure timeline, the Add Track control, and an empty state that tells the user to add a track or describe a part in the chat. The dock, when open, SHALL show an empty state with no piano roll. Playback, song settings, the chat, and project download SHALL remain usable.

#### Scenario: Edit the selected clip's loop
- **WHEN** the user selects a Piano clip and clicks an empty cell in row `C4` at step 8
- **THEN** a `C4` note appears at step 8 of that clip's loop, with length 1 and velocity 100
- **AND** it plays in every clip of that loop, and every clip of that loop shows it in the lane overview

#### Scenario: Switching tracks keeps edits
- **WHEN** the user edits a Drums clip, selects a Piano clip, and then selects the Drums clip again
- **THEN** the Drums edits are still present

#### Scenario: Empty song
- **WHEN** the Studio opens a song with no tracks
- **THEN** it shows the measure timeline, the Add Track control, and the empty-arrangement message, and no lanes

#### Scenario: First track in an empty song
- **WHEN** the user adds a Drums track to a song with no tracks
- **THEN** the song has one Drums lane, and that track is selected

### Requirement: Track mixer
Each track's header SHALL have a volume control (−60 to +6 dB, default 0), a pan control (−1.0 to +1.0, default 0, with a way to reset it to center), a Mute toggle, and a Solo toggle. A track SHALL be audible when it is not muted and either no track is soloed or it is soloed. Mixer changes SHALL take effect during playback within 50 ms, without restarting playback.

#### Scenario: Solo isolates tracks
- **WHEN** the song has Drums, Bass, and Piano tracks and the user solos Bass
- **THEN** only the Bass track is heard

#### Scenario: Mute overrides solo
- **WHEN** a track is both soloed and muted
- **THEN** that track is not heard

#### Scenario: Pan hard left
- **WHEN** a track's pan is set to −1.0
- **THEN** that track is heard only in the left channel

#### Scenario: Volume change during playback
- **WHEN** the song is playing and the user lowers a track's volume to −12 dB
- **THEN** that track becomes quieter without playback stopping or restarting

### Requirement: Mixed song playback
The Studio page SHALL provide the transport behavior of `patterns/playback`, applied to the whole song. This SHALL include:
- Play, Stop, and Space to toggle;
- the Loop toggle, and an optional loop region in song measures that is drawn and edited on the arrangement's measure ruler above the lanes;
- playing once through the song when looping is off;
- a playhead shown across the lanes and the open piano roll;
- accurate timing, velocity, and note length for sustained and one-shot instruments;
- live edits being audible.

Every audible track SHALL be played at the same time with its own instrument's sounds, using the song's tempo, swing, and time signature.

- **Seeking:** clicking empty lane space to seek SHALL set where Play starts only while looping is off. While looping is on, Play SHALL start at the region's first measure, or at measure 1 when there is no region.
- **The dock's ruler:** the docked piano roll's ruler counts measures within the selected clip's loop. It SHALL NOT show or edit the song's loop region.
- **Region bounds:** the region SHALL be bounded by the arrangement's visible timeline (see "Song settings"), not by the song's length, so it MAY cover silent measures after the song's end. Looping with no region, and playing once, SHALL still use the song's length. When the song shrinks, a region inside the new timeline SHALL be kept, and one extending past it SHALL be clamped to it.
- **New songs:** a new song, or one saved before loop regions existed, SHALL open with no loop region and looping off, so Play plays the song once. Turning on the Loop toggle with no region SHALL loop the whole song.

#### Scenario: Tracks play together
- **WHEN** a song has a kick on step 0 of the Drums track and a `C3` on step 0 of the Bass track, and the user presses Play
- **THEN** both notes start at the same time with their own instruments' sounds

#### Scenario: New song has no region
- **WHEN** the user creates a new song
- **THEN** the arrangement ruler shows no loop region, the Loop toggle is not pressed, and no lane measures are shaded

#### Scenario: Loop a range across tracks
- **WHEN** the song has no loop region and the user drags across measures 5–8 on the arrangement ruler and presses Play
- **THEN** measures 5–8 of every audible track play, repeating

#### Scenario: Song plays once
- **WHEN** looping is off on a 16-measure song and the user presses Play
- **THEN** every audible track plays measures 1–16 once, and playback stops by itself

#### Scenario: Seek with looping off
- **WHEN** looping is off, the user clicks empty lane space in measure 9, and then presses Play
- **THEN** playback starts at measure 9 and stops by itself after the song's last measure

#### Scenario: Region past the song's end
- **WHEN** a song's clips end at measure 4 and the user drags across measures 6–9 on the arrangement ruler and presses Play with looping on
- **THEN** the region is 6–9, and playback repeats those silent measures

#### Scenario: Region kept when the song shrinks
- **WHEN** the song is 12 measures long with a region of 9–12, and the user deletes the clip so the song is 4 measures long
- **THEN** the region is still 9–12, because the timeline still shows 16 measures

#### Scenario: Region clamped to the timeline
- **WHEN** the song is 20 measures long with a region of 25–28, and the song shrinks to 4 measures
- **THEN** the region becomes measure 16 only, the end of the 16-measure timeline

#### Scenario: Region is not in the dock
- **WHEN** the song's region is measures 5–8 and a clip's loop is open in the dock
- **THEN** the dock's ruler shows no loop region and no loop shading

### Requirement: Undo and redo on the Studio page
The Studio page SHALL support undo and redo, via on-screen buttons and Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z, of note edits on any track, track add, rename, and delete, song setting changes, and mixer changes. A continuous volume or pan drag SHALL be recorded as one undo step. Selecting a track and transport actions SHALL NOT be recorded. Undo history SHALL be kept per open song and SHALL NOT survive a page reload.

#### Scenario: Undo a track deletion
- **WHEN** the user deletes the Bass track and presses Cmd/Ctrl+Z
- **THEN** the Bass track is restored with its notes and mixer settings

#### Scenario: One drag, one undo step
- **WHEN** the user drags a volume slider from 0 dB to −10 dB in one gesture and then presses Cmd/Ctrl+Z
- **THEN** the volume returns to 0 dB

### Requirement: Creating a song
The Songs library SHALL offer a "New song" action that creates a song with the new-song defaults and opens it immediately, without asking for a name, a time signature, or confirmation. The new song SHALL be named "Untitled song". If the user already has a song with that name, it SHALL be named "Untitled song N", where N is the smallest number from 2 up that no existing song uses. Names SHALL be compared ignoring letter case and surrounding whitespace. The user SHALL be able to rename the song afterwards from the song header, and change its time signature from song settings.

#### Scenario: New song opens immediately
- **WHEN** the user chooses "New song" in the Songs library
- **THEN** a new song named "Untitled song" in 4/4 opens in the Studio, and no dialog is shown

#### Scenario: Default names stay distinct
- **WHEN** the library already has songs named "Untitled song" and "Untitled song 2", and the user chooses "New song"
- **THEN** the new song is named "Untitled song 3"

#### Scenario: Gap is reused
- **WHEN** the library has "Untitled song" and "Untitled song 3", but no "Untitled song 2", and the user chooses "New song"
- **THEN** the new song is named "Untitled song 2"

#### Scenario: Rename afterwards
- **WHEN** the user creates a new song and then renames it to "Late Train" from the song header
- **THEN** the song is listed as "Late Train" in the Songs library

### Requirement: Account song library
Songs SHALL be saved to the signed-in user's projects (see `songs/project-storage`) automatically, within about a second after each change. The Studio page SHALL list the user's projects by name and last-modified time, most recent first, and SHALL show no one else's. It SHALL let the user create, open, rename, duplicate, and delete songs, and it SHALL ask for confirmation before deleting. Reloading the page SHALL reopen the song this user most recently opened in this browser, in the state it was last saved. A user with no projects SHALL get a new song created for them.
- **Save failure:** when a save fails for a reason other than `401`, the page SHALL show a message saying changes are not being saved, editing SHALL continue to work, and saving SHALL be retried.
- **Saving too often:** when a save gets `429`, the page SHALL save again after the `Retry-After` time and SHALL NOT show it as a failure, because it only means the server's minimum time between saves hasn't passed.
- **Conflict:** when a save gets `revision_conflict`, the page SHALL stop autosaving that song and tell the user that it was changed elsewhere. It SHALL offer to reload the saved version, discarding this tab's unsaved changes, or to save this tab's version as a new copy.
- **Leaving:** when the user tries to close or leave the page with a change that has not been saved yet, the browser SHALL warn them.

#### Scenario: Reload restores the song
- **WHEN** the user edits a track's notes and mixer settings and reloads the page
- **THEN** the same song opens with the same notes and mixer settings

#### Scenario: Songs follow the user to another browser
- **WHEN** the user saves "Late Train" in one browser and signs in on another
- **THEN** "Late Train" is in the Studio's song list there and opens with the same contents

#### Scenario: Duplicate a song
- **WHEN** the user duplicates the song "Demo"
- **THEN** a new song "Demo (copy)" with its own id and identical tracks appears in the list, and editing it does not change "Demo"

#### Scenario: Save deferred, not failed
- **WHEN** a save gets `429` with `Retry-After: 1`
- **THEN** no "not being saved" message appears, and the latest changes are saved about a second later

#### Scenario: Server unavailable
- **WHEN** the server cannot be reached when a save is attempted
- **THEN** the page shows a message saying changes are not being saved, and editing continues to work

#### Scenario: Edited in two tabs
- **WHEN** the user edits the same song in two tabs and the second tab's save gets a revision conflict
- **THEN** the second tab says the song was changed elsewhere and offers to reload it or save a copy

#### Scenario: Local songs are not migrated
- **WHEN** a user signs in on a browser that holds songs saved before accounts existed
- **THEN** those songs are not shown in the song list and are not uploaded
