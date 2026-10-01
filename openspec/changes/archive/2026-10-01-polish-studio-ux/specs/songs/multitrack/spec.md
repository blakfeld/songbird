## MODIFIED Requirements

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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Tracks with one instrument each
**Reason**: Songs may now have no tracks, so the rule that the last track cannot be deleted no longer holds.
**Migration**: Replaced by "Adding, renaming, and deleting tracks", which keeps every other rule and lets the last track be deleted. Existing songs are unaffected.
