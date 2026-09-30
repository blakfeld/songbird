# Spec Delta

## MODIFIED Requirements

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
