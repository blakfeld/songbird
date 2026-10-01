## MODIFIED Requirements

### Requirement: Song validation for export
The endpoint SHALL reject a song with status `422` and error code `invalid_song` when any of the following is true:
- a field is outside the ranges of the song document, or the song document `version` is not 2;
- the song has more than 16 tracks;
- a loop note references a row that is not a row of its track's instrument, or extends past the end of its loop;
- a loop or clip id is not unique within the song, or a loop's `measures` is outside 1–128;
- a clip's `loop_id` does not name a loop on the same track;
- a clip extends outside the song, or two clips on the same track overlap;
- a track has more than 64 loops or more than 256 clips.

A song with no tracks SHALL be accepted, and the file SHALL contain only the conductor track.

These clip rules SHALL match the rules the browser applies when it opens a song, so a song the Studio can open is never rejected for its clips.

A track whose instrument is not listed by `GET /api/v1/instruments` SHALL be rejected with `422` and error code `invalid_instrument`. The error message SHALL name the offending track.

#### Scenario: Unknown row
- **WHEN** a Piano track contains a note with `row_id` `"kick"`
- **THEN** the response is `422` with error code `invalid_song` and a message naming that track

#### Scenario: Unknown instrument
- **WHEN** a track's instrument is `"kazoo"`
- **THEN** the response is `422` with error code `invalid_instrument`

#### Scenario: Clip names another track's loop
- **WHEN** a Bass track has a clip whose `loop_id` names a loop on the Drums track
- **THEN** the response is `422` with error code `invalid_song` and a message naming the Bass track

#### Scenario: Overlapping clips
- **WHEN** a track has one clip covering measures 1–4 and another starting at measure 3
- **THEN** the response is `422` with error code `invalid_song`

#### Scenario: Song with no tracks
- **WHEN** a client posts a valid song with no tracks
- **THEN** the response is `200` with a MIDI file containing only the conductor track

#### Scenario: Too many tracks
- **WHEN** a client posts a song with 17 tracks
- **THEN** the response is `422` with error code `invalid_song`

### Requirement: Download song MIDI from the Studio
The Studio page SHALL provide a "Download MIDI" action that exports the currently open song, including unsaved edits, through the export endpoint and saves the returned file. If export fails, the page SHALL show the error message and leave the song unchanged. The action SHALL be disabled while the song has no tracks, because the file would hold no music.

#### Scenario: Download current song
- **WHEN** the user clicks "Download MIDI" in the Studio
- **THEN** a `.mid` file named from the song name and tempo is downloaded, containing every track

#### Scenario: Nothing to download
- **WHEN** the open song has no tracks
- **THEN** the "Download MIDI" action is disabled
