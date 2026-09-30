# Spec Delta

## Purpose

Lets songwriters take a whole multitrack song out of Songbird: as a multitrack Standard MIDI File for their DAW, and as a Songbird project file they can keep, move to another browser, and open again.

## ADDED Requirements

### Requirement: Multitrack MIDI export endpoint
The system SHALL expose `POST /api/v1/songs/export/midi`. It SHALL accept a song document as its JSON body and respond `200` with `Content-Type: audio/midi`, the Standard MIDI File as the body, and a `Content-Disposition` attachment filename of `songbird-<slug of song name>-<tempo_bpm>bpm.mid`. The endpoint SHALL NOT store the song.

#### Scenario: Export a two-track song
- **WHEN** a client posts a valid song named "Late Train" at 96 BPM with a Drums track and a Piano track
- **THEN** the response is `200` with `Content-Type: audio/midi` and filename `songbird-late-train-96bpm.mid`

### Requirement: Song validation for export
The endpoint SHALL reject a song with status `422` and error code `invalid_song` when any of the following is true:
- a field is outside the ranges of the song document;
- the song has no tracks or more than 16 tracks;
- a note references a row that is not a row of its track's instrument;
- a note starts beyond the end of the song.

A track whose instrument is not listed by `GET /api/v1/instruments` SHALL be rejected with `422` and error code `invalid_instrument`. The error message SHALL name the offending track.

#### Scenario: Unknown row
- **WHEN** a Piano track contains a note with `row_id` `"kick"`
- **THEN** the response is `422` with error code `invalid_song` and a message naming that track

#### Scenario: Unknown instrument
- **WHEN** a track's instrument is `"kazoo"`
- **THEN** the response is `422` with error code `invalid_instrument`

### Requirement: Multitrack MIDI file contents
The exported file SHALL be a Type 1 Standard MIDI File at 480 ticks per quarter note.
- **First track (conductor):** the song name, a tempo meta-event matching `tempo_bpm`, and a time-signature meta-event matching `time_signature`.
- **Remaining tracks:** one MIDI track per song track, in song order, including muted tracks. Each contains, at tick 0:
  - a track-name meta-event with the track's name;
  - for melodic instruments, a Program Change to the instrument's `midi_program`;
  - a Control Change 7 (volume) and a Control Change 10 (pan) derived from the mixer.
- **Notes:** each track then contains its notes as Note On / Note Off pairs. Timing, swing, overlap handling, and note-length rules SHALL be the same as single-pattern export.
- **Channels:** drums tracks SHALL use channel 10. Melodic tracks SHALL be assigned channels 1–9 and then 11–16, in track order.
- **End of track:** every track SHALL end with End of Track at the end of the song's final measure.

#### Scenario: Track layout
- **WHEN** a song with tracks Drums, Bass, and Keys, in that order, is exported
- **THEN** the file has 4 tracks: the conductor, then "Drums" on channel 10, "Bass" on channel 1, and "Keys" on channel 2

#### Scenario: Program change for melodic tracks
- **WHEN** a track using `piano` (program 1) is exported
- **THEN** its MIDI track contains a Program Change to program 1 (wire value 0) at tick 0 on its channel, and the drums track contains no Program Change

#### Scenario: Notes are absolute song time
- **WHEN** a Bass track has a note at step 32 with length 4 in a 4/4 song with no swing
- **THEN** its Note On is at tick 3840 and its Note Off is at tick 4320

#### Scenario: Region length is the song length
- **WHEN** a 12-measure 4/4 song whose last note is in measure 3 is exported
- **THEN** every track's End of Track event is at tick 23040

#### Scenario: Empty track still exported
- **WHEN** a song contains a track with no notes
- **THEN** the file still contains that track, with its name and controller events

### Requirement: Mixer values in exported MIDI
Volume SHALL be written as Control Change 7 with value `round(100 × 10^(volume_db / 40))`, clamped to 0–127. This puts 0 dB at 100, leaving headroom for boosts. Pan SHALL be written as Control Change 10 with value 64 for center, `round(64 + pan × 64)` for negative pan, and `round(64 + pan × 63)` for positive pan. Mute and solo state SHALL NOT affect the exported notes or controllers.

#### Scenario: Default mixer values
- **WHEN** a track at 0 dB and pan 0 is exported
- **THEN** it has CC7 value 100 and CC10 value 64

#### Scenario: Extreme values
- **WHEN** a track at −60 dB and pan −1.0 is exported, and another at +6 dB and pan +1.0
- **THEN** the first has CC7 value 3 and CC10 value 0, and the second has CC7 value 127 and CC10 value 127

#### Scenario: Muted track keeps its notes
- **WHEN** a muted track with 10 notes is exported
- **THEN** its MIDI track contains all 10 notes

### Requirement: Multitrack DAW compatibility
Exported song files SHALL parse without errors in standard MIDI parsers, and SHALL import into Logic Pro as one track per song track with the drums track's notes on General MIDI drum sounds.

#### Scenario: Round-trip parse
- **WHEN** an exported song file is parsed by an independent MIDI library
- **THEN** parsing succeeds, and for every track the recovered channel, notes, velocities, start times, and durations match the song

### Requirement: Download song MIDI from the Studio
The Studio page SHALL provide a "Download MIDI" action that exports the currently open song, including unsaved edits, through the export endpoint and saves the returned file. If export fails, the page SHALL show the error message and leave the song unchanged.

#### Scenario: Download current song
- **WHEN** the user clicks "Download MIDI" in the Studio
- **THEN** a `.mid` file named from the song name and tempo is downloaded, containing every track

### Requirement: Project file download
The Studio page SHALL provide a "Download project" action. It SHALL save the open song as a UTF-8 JSON file named `<slug of song name>.songbird.json` containing `{"format": "songbird-song", "version": 1, "song": <song document>}`. Undo history and UI state SHALL NOT be included.

#### Scenario: Download a project
- **WHEN** the user clicks "Download project" for the song "Late Train"
- **THEN** a file `late-train.songbird.json` is saved whose `format` is `"songbird-song"`, whose `version` is 1, and whose `song` equals the open song

### Requirement: Project file import
The Studio page SHALL provide an "Open project" action that accepts a `.songbird.json` file of at most 5 MB, validates it, and adds it to the browser song library as a new song, then opens it. The file SHALL be rejected, with a message stating the reason and without changing the library, when:
- it is not valid JSON, or its `format` is not `"songbird-song"`;
- its `version` is newer than the version this app supports;
- any track uses an instrument this service does not list;
- any value is outside the ranges of the song document.

Fields of the song document that this app does not recognise SHALL NOT cause rejection and SHALL be kept unchanged, because later versions add optional fields without changing `version`. The `version` SHALL only increase for a change that older apps cannot read correctly.

If the file's song `id` already exists in the library, the imported song SHALL receive a new id so that both are kept. No data SHALL be sent to the server for storage during import.

#### Scenario: Round trip
- **WHEN** the user downloads a project and then opens that file in another browser
- **THEN** the song opens with identical name, settings, tracks, notes, and mixer values

#### Scenario: Newer version rejected
- **WHEN** the user opens a file with `"version": 2`
- **THEN** the import is rejected with a message saying the file was made by a newer version of Songbird, and the library is unchanged

#### Scenario: Unrecognised optional field kept
- **WHEN** the user opens a version 1 file whose song has an extra field `"mood": "wistful"` that this app does not know
- **THEN** the import succeeds and downloading the project again produces a song that still contains `"mood": "wistful"`

#### Scenario: Unknown instrument rejected
- **WHEN** the user opens a file containing a track with instrument `"theremin"` that the service does not list
- **THEN** the import is rejected with a message naming `theremin`

#### Scenario: Duplicate id kept separately
- **WHEN** the user opens a project whose song id matches a song already in the library
- **THEN** the library contains both songs, and the imported one has a new id
