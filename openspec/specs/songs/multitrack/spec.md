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
- `measures`, an integer from 1 to 128;
- an ordered list of 1–16 `tracks`.

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

#### Scenario: New song defaults
- **WHEN** the user creates a new song
- **THEN** it has these settings:
  - It is named "Untitled song".
  - It is 8 measures of 4/4 at 120 BPM with swing 0.
  - It has two tracks: a Drums track using `drums` and a Piano track using `piano`.
  - Each track is at 0 dB, centered, not muted, and not soloed, and has no loops and no clips.

#### Scenario: Rows come from the track's instrument
- **WHEN** a track uses the `drums` instrument
- **THEN** its piano roll shows exactly the drums instrument's rows, and every note in the track's loops references one of them

### Requirement: Tracks with one instrument each
The Studio page SHALL let the user add a track by choosing an instrument from those listed by `GET /api/v1/instruments`, rename a track, and delete a track. Each track SHALL have exactly one instrument, which SHALL NOT change after the track is created. The same instrument MAY be used by several tracks. The Add Track control SHALL be disabled when the song has 16 tracks. The Delete control SHALL be disabled when the song has only one track.

#### Scenario: Add a second piano track
- **WHEN** a song already has a Piano track and the user adds another track choosing `piano`
- **THEN** the song has two independent piano tracks whose notes can be edited separately

#### Scenario: Track limit
- **WHEN** a song has 16 tracks
- **THEN** the Add Track control is disabled

#### Scenario: Last track cannot be deleted
- **WHEN** a song has exactly one track
- **THEN** that track's Delete control is disabled

### Requirement: Song settings
The user SHALL be able to rename the song and change its tempo (40–240 BPM), swing (0–75%), and length (1–128 measures). The time signature SHALL be chosen when the song is created and SHALL NOT be changed afterward.

Lengthening a song SHALL add empty measures at the end, with no clips in them. Shortening a song SHALL, on every track:
- delete the clips that start beyond the new end;
- shorten the clips that cross the new end so that they end at it.

Changing the song's length SHALL NOT change any loop's contents or length.

#### Scenario: Lengthen appends silence
- **WHEN** an 8-measure song is lengthened to 12 measures
- **THEN** measures 9–12 have no clips on any track, and measures 1–8 are unchanged

#### Scenario: Shorten trims clips
- **WHEN** a 12-measure song has a clip covering measures 7–10 and another covering measures 11–12, and the song is shortened to 8 measures
- **THEN** the first clip covers measures 7–8, the second clip is deleted, and both clips' loops keep all their notes

### Requirement: Arrangement overview and track editing
The Studio page SHALL show one lane per track, in track order, on a shared measure timeline with measure numbers.
- **Lanes:** each lane SHALL have a header and a timeline area. The header SHALL show the track's number, name, instrument, and mixer controls. The timeline area SHALL show the track's clips as described in `songs/clips`.
- **Editing:** selecting a clip SHALL open its loop in a piano roll docked below the arrangement, as described in `songs/clips`, using the track's instrument rows.
- **Updates:** edits SHALL be reflected immediately in the lane overview, in playback, and in saved state.

#### Scenario: Edit the selected clip's loop
- **WHEN** the user selects a Piano clip and clicks an empty cell in row `C4` at step 8
- **THEN** a `C4` note appears at step 8 of that clip's loop, with length 1 and velocity 100
- **AND** it plays in every clip of that loop, and every clip of that loop shows it in the lane overview

#### Scenario: Switching tracks keeps edits
- **WHEN** the user edits a Drums clip, selects a Piano clip, and then selects the Drums clip again
- **THEN** the Drums edits are still present

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
The Studio page SHALL provide the transport behavior of `patterns/playback`, applied to the whole song: Play, Stop, Space to toggle, looping of the whole song or of a measure range, a playhead shown across the lanes and the open piano roll, accurate timing, velocity, note length for sustained and one-shot instruments, and live edits being audible. Every audible track SHALL be played at the same time with its own instrument's sounds, using the song's tempo, swing, and time signature.

#### Scenario: Tracks play together
- **WHEN** a song has a kick on step 0 of the Drums track and a `C3` on step 0 of the Bass track, and the user presses Play
- **THEN** both notes start at the same time with their own instruments' sounds

#### Scenario: Loop a range across tracks
- **WHEN** the user sets the loop range to measures 5–8 and presses Play
- **THEN** measures 5–8 of every audible track play, repeating

### Requirement: Undo and redo on the Studio page
The Studio page SHALL support undo and redo, via on-screen buttons and Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z, of note edits on any track, track add, rename, and delete, song setting changes, and mixer changes. A continuous volume or pan drag SHALL be recorded as one undo step. Selecting a track and transport actions SHALL NOT be recorded. Undo history SHALL be kept per open song and SHALL NOT survive a page reload.

#### Scenario: Undo a track deletion
- **WHEN** the user deletes the Bass track and presses Cmd/Ctrl+Z
- **THEN** the Bass track is restored with its notes and mixer settings

#### Scenario: One drag, one undo step
- **WHEN** the user drags a volume slider from 0 dB to −10 dB in one gesture and then presses Cmd/Ctrl+Z
- **THEN** the volume returns to 0 dB

### Requirement: Browser song library
Songs SHALL be saved in the browser automatically after each change and SHALL NOT be sent to the server for storage. The Studio page SHALL list saved songs by name and last-modified time, most recent first. It SHALL let the user create, open, rename, duplicate, and delete songs, and it SHALL ask for confirmation before deleting. Reloading the page SHALL reopen the most recently opened song in the state it was last saved.

#### Scenario: Reload restores the song
- **WHEN** the user edits a track's notes and mixer settings and reloads the page
- **THEN** the same song opens with the same notes and mixer settings

#### Scenario: Duplicate a song
- **WHEN** the user duplicates the song "Demo"
- **THEN** a new song "Demo (copy)" with its own id and identical tracks appears in the list, and editing it does not change "Demo"

#### Scenario: Storage unavailable
- **WHEN** browser storage is unavailable or full when a save is attempted
- **THEN** the page shows a message saying changes are not being saved, and editing continues to work
