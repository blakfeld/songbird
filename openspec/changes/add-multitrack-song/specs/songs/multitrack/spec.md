# Spec Delta

## Purpose

Lets songwriters build a song from several instrument tracks on one shared timeline, edit each track on the piano roll, balance them with volume, pan, mute, and solo, and hear them played together in the browser.

## ADDED Requirements

### Requirement: Song document
A song SHALL have an `id`, a `name` (1–80 characters), `tempo_bpm` (40–240), `time_signature` (`"4/4"`, `"3/4"`, or `"6/8"`), `swing` (0.0–0.75), `measures` (integer 1–128), and an ordered list of 1–16 `tracks`. Step resolution and `steps_per_measure` SHALL follow the same sixteenth-note rules as a pattern document. Each track SHALL have an `id`, a `name` (1–40 characters), an `instrument` (an instrument id listed by `GET /api/v1/instruments`), `volume_db` (−60.0 to +6.0), `pan` (−1.0 full left to +1.0 full right), `muted` and `soloed` flags, and `notes` in the pattern note shape (`row_id`, `step`, `length_steps`, `velocity`). Here `step` is absolute from the start of the song and `row_id` is a row of the track's instrument. No note SHALL extend past the end of the song, and no two notes in the same row of a track SHALL overlap.

#### Scenario: New song defaults
- **WHEN** the user creates a new song
- **THEN** it is named "Untitled song", is 8 measures of 4/4 at 120 BPM with swing 0, and has two tracks, a Drums track using `drums` and a Piano track using `piano`, each at 0 dB, centered, not muted, not soloed, and empty

#### Scenario: Rows come from the track's instrument
- **WHEN** a track uses the `drums` instrument
- **THEN** its piano roll shows exactly the drums instrument's rows, and every note on the track references one of them

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
The user SHALL be able to rename the song and change its tempo (40–240 BPM), swing (0–75%), and length (1–128 measures). The time signature SHALL be chosen when the song is created and SHALL NOT be changed afterward. Lengthening a song SHALL append empty measures to every track. Shortening a song SHALL drop, on every track, the notes that start beyond the new end and SHALL shorten the notes that cross it.

#### Scenario: Lengthen appends silence
- **WHEN** an 8-measure song is lengthened to 12 measures
- **THEN** measures 9–12 are empty on every track and measures 1–8 are unchanged

#### Scenario: Shorten truncates every track
- **WHEN** a 12-measure song whose tracks have notes in measures 10–12 is shortened to 8 measures
- **THEN** no track has a note starting after measure 8 and no note extends past measure 8

### Requirement: Arrangement overview and track editing
The Studio page SHALL show one lane per track, in track order, on a shared measure timeline. Each lane SHALL show the track's name, its instrument, and a compact overview of where the track has notes. Selecting a track SHALL open it in a piano roll below the lanes. That piano roll SHALL offer the same display, note editing, and resizing behavior as the single-instrument editor (see `patterns/piano-roll-editor`), using the selected track's instrument rows. Edits SHALL be reflected immediately in the lane overview, in playback, and in saved state.

#### Scenario: Edit the selected track
- **WHEN** the user selects the Piano track and clicks an empty cell in row `C4` at step 8
- **THEN** a `C4` note of length 1 and velocity 100 appears at step 8 on the Piano track only, and the Piano lane overview shows it

#### Scenario: Switching tracks keeps edits
- **WHEN** the user edits the Drums track, selects the Piano track, and then selects the Drums track again
- **THEN** the Drums edits are still present

### Requirement: Track mixer
Each track SHALL have a volume control (−60 to +6 dB, default 0), a pan control (−1.0 to +1.0, default 0, with a way to reset it to center), a Mute toggle, and a Solo toggle. A track SHALL be audible when it is not muted and either no track is soloed or it is soloed. Mixer changes SHALL take effect during playback within 50 ms, without restarting playback.

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
