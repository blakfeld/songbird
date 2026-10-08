# songs/export Specification

## Purpose

Lets songwriters take a whole multitrack song out of Songbird: as a multitrack Standard MIDI File for their DAW, and as a Songbird project file they can keep, move to another browser, and open again.

## Requirements

### Requirement: Multitrack MIDI export endpoint
The system SHALL expose `POST /api/v1/songs/export/midi`. It SHALL accept a song document as its JSON body and respond `200` with `Content-Type: audio/midi`, the Standard MIDI File as the body, and a `Content-Disposition` attachment filename of `songbird-<slug of song name>-<tempo_bpm>bpm.mid`. The endpoint SHALL NOT store the song.

#### Scenario: Export a two-track song
- **WHEN** a client posts a valid song named "Late Train" at 96 BPM with a Drums track and a Piano track
- **THEN** the response is `200` with `Content-Type: audio/midi` and filename `songbird-late-train-96bpm.mid`

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

### Requirement: Multitrack MIDI file contents
The exported file SHALL be a Type 1 Standard MIDI File at 480 ticks per quarter note.
- **First track (conductor):** the song name, a tempo meta-event matching `tempo_bpm`, and a time-signature meta-event matching `time_signature`.
- **Remaining tracks:** one MIDI track per instrument track, in song order, including muted tracks. Audio tracks SHALL be left out, because MIDI cannot carry audio; use the WAV mixdown for them. Each contains, at tick 0:
  - a track-name meta-event with the track's name;
  - for melodic instruments, a Program Change to the instrument's `midi_program`;
  - a Control Change 7 (volume) and a Control Change 10 (pan) derived from the mixer.
- **Notes:** each track then contains, as Note On / Note Off pairs, exactly the notes its clips play during song playback: each clip plays its loop from the clip's start measure, repeating when the clip is longer than the loop, playing only the loop's start when it is shorter, cutting notes off at the clip's end, and nothing outside clips (see `songs/clips`, "What a clip plays"). Timing, swing, overlap handling, and note-length rules SHALL be the same as single-pattern export.
- **Channels:** drums tracks SHALL use channel 10. Melodic tracks SHALL be assigned channels 1–9 and then 11–16, in track order, skipping audio tracks.
- **End of track:** every track SHALL end with End of Track at the end of the song's final measure.

#### Scenario: Track layout
- **WHEN** a song with tracks Drums, Bass, and Keys, in that order, is exported
- **THEN** the file has 4 tracks: the conductor, then "Drums" on channel 10, "Bass" on channel 1, and "Keys" on channel 2

#### Scenario: Program change for melodic tracks
- **WHEN** a track using `piano` (program 1) is exported
- **THEN** its MIDI track contains a Program Change to program 1 (wire value 0) at tick 0 on its channel, and the drums track contains no Program Change

#### Scenario: Notes are absolute song time
- **WHEN** in a 4/4 song with no swing, a Bass track's loop has a note at loop step 0 with length 4, and the loop is placed as one clip starting at measure 3
- **THEN** its Note On is at tick 3840 and its Note Off is at tick 4320

#### Scenario: Clips are expanded
- **WHEN** in a 4/4 song, a 1-measure Drums loop has a kick at loop step 0, and it is placed as one 4-measure clip starting at measure 1
- **THEN** the Drums MIDI track has four kicks, with Note Ons at ticks 0, 1920, 3840, and 5760

#### Scenario: Note cut at the clip end
- **WHEN** a 2-measure loop has a note starting at the first step of its second measure lasting 2 measures, and it is placed as a 2-measure clip
- **THEN** that note's Note Off is at the clip's end, not 1 measure later

#### Scenario: Region length is the song length
- **WHEN** a 12-measure 4/4 song whose last note is in measure 3 is exported
- **THEN** every track's End of Track event is at tick 23040

#### Scenario: Empty track still exported
- **WHEN** a song contains a track with no clips
- **THEN** the file still contains that track, with its name and controller events

#### Scenario: Audio tracks left out
- **WHEN** a song with tracks Drums, Loops (audio), and Bass is exported to MIDI
- **THEN** the file has 3 tracks: the conductor, "Drums" on channel 10, and "Bass" on channel 1

### Requirement: Mixer values in exported MIDI
Volume SHALL be written as Control Change 7 with value `round(100 × 10^(volume_db / 40))`, clamped to 0–127. This puts 0 dB at 100, leaving headroom for boosts. Pan SHALL be written as Control Change 10 with value 64 for center, `round(64 + pan × 64)` for negative pan, and `round(64 + pan × 63)` for positive pan. Mute and solo state SHALL NOT affect the exported notes or controllers.

#### Scenario: Default mixer values
- **WHEN** a track at 0 dB and pan 0 is exported
- **THEN** it has CC7 value 100 and CC10 value 64

#### Scenario: Extreme values
- **WHEN** a track at −60 dB and pan −1.0 is exported, and another at +6 dB and pan +1.0
- **THEN** the first has CC7 value 3 and CC10 value 0, and the second has CC7 value 127 and CC10 value 127

#### Scenario: Muted track keeps its notes
- **WHEN** a muted track whose clips play 10 notes is exported
- **THEN** its MIDI track contains all 10 notes

### Requirement: Multitrack DAW compatibility
Exported song files SHALL parse without errors in standard MIDI parsers, and SHALL import into Logic Pro as one track per song track with the notes played by the drums track's clips on General MIDI drum sounds.

#### Scenario: Round-trip parse
- **WHEN** an exported song file is parsed by an independent MIDI library
- **THEN** parsing succeeds, and for every track the recovered channel, notes, velocities, start times, and durations match the notes its clips play

### Requirement: Download song MIDI from the Studio
The Studio page SHALL provide a "Download MIDI" action that exports the currently open song, including unsaved edits, through the export endpoint and saves the returned file. If export fails, the page SHALL show the error message and leave the song unchanged. The action SHALL be disabled while the song has no tracks, because the file would hold no music.

#### Scenario: Download current song
- **WHEN** the user clicks "Download MIDI" in the Studio
- **THEN** a `.mid` file named from the song name and tempo is downloaded, containing every track

#### Scenario: Nothing to download
- **WHEN** the open song has no tracks
- **THEN** the "Download MIDI" action is disabled

### Requirement: Project file download
The Studio page SHALL provide a "Download project" action. It SHALL save the open song as a UTF-8 JSON file named `<slug of song name>.songbird.json` containing `{"format": "songbird-song", "version": 1, "song": <song document>}`. The project-file `version` is independent of the song document's own `version` (2), and the song document SHALL be saved with its loops and clips as they are, not flattened. Undo history and UI state SHALL NOT be included.

#### Scenario: Download a project
- **WHEN** the user clicks "Download project" for the song "Late Train"
- **THEN** a file `late-train.songbird.json` is saved whose `format` is `"songbird-song"`, whose `version` is 1, and whose `song` equals the open song

### Requirement: Project file import
The Studio page SHALL provide an "Open project" action that accepts a `.songbird.json` file of at most 5 MB, validates it, and adds it to the signed-in user's projects as a new project (see `songs/project-storage`), then opens it. The file SHALL be rejected, with a message stating the reason and without changing the library, when:
- it is not valid JSON, or its `format` is not `"songbird-song"`;
- its project-file `version` is newer than the version this app supports;
- its song document cannot be opened by the song library, including when its loops and clips break the song document's rules;
- any track uses an instrument this service does not list;
- any value is outside the ranges of the song document.

A song document from an older song `version` SHALL be converted exactly as the song library converts it on load.

Fields of the song document that this app does not recognise SHALL NOT cause rejection and SHALL be kept unchanged, because later versions add optional fields without changing `version`. The `version` SHALL only increase for a change that older apps cannot read correctly.

The imported song SHALL always receive a new id from the server, so that it never replaces an existing project. The file SHALL be checked in the browser before anything is sent to the server. If the server then refuses the song, the import SHALL fail with the server's message, and the library SHALL be unchanged.

#### Scenario: Round trip
- **WHEN** the user downloads a project and then opens that file while signed in to another account
- **THEN** the song opens with identical name, settings, tracks, loops, clips, and mixer values

#### Scenario: Newer version rejected
- **WHEN** the user opens a file with project-file `"version": 2`
- **THEN** the import is rejected with a message saying the file was made by a newer version of Songbird, and the library is unchanged

#### Scenario: Unrecognised optional field kept
- **WHEN** the user opens a version 1 file whose song has an extra field `"mood": "wistful"` that this app does not know
- **THEN** the import succeeds and downloading the project again produces a song that still contains `"mood": "wistful"`

#### Scenario: Invalid clips rejected
- **WHEN** the user opens a file in which two clips on the same track overlap
- **THEN** the import is rejected with a message naming that track, and the library is unchanged

#### Scenario: Unknown instrument rejected
- **WHEN** the user opens a file containing a track with instrument `"theremin"` that the service does not list
- **THEN** the import is rejected with a message naming `theremin`

#### Scenario: Duplicate id kept separately
- **WHEN** the user opens a project file whose song id matches a project already in their library
- **THEN** the library contains both songs, and the imported one has a new id

### Requirement: Download WAV mixdown
The Studio page SHALL provide a "Download WAV" action that renders the open song, including unsaved edits, in the browser. The render SHALL be a 16-bit stereo WAV at the audio context's sample rate, and it SHALL sound as the song plays:
- every instrument and audio track;
- the tracks' sound settings and effects, volume, and pan;
- mute and solo as they are set.

It SHALL run from the start of measure 1 to the end of the song, plus up to 4 seconds while effect tails fade below −60 dBFS. Looping and the count-in SHALL be ignored. The file SHALL be named `songbird-<slug of song name>-<tempo_bpm>bpm.wav`. The page SHALL show progress and offer Cancel, and editing SHALL remain possible during the render. The render SHALL reflect the song as it was when the action started. Nothing SHALL be sent to the server. When the mix reaches full scale, the page SHALL warn after the download that the mix clipped.

#### Scenario: Mixdown includes audio tracks
- **WHEN** the user downloads a WAV of a song with a Piano track and an audio track playing a drum loop
- **THEN** the downloaded file contains both the piano and the drum loop, with the tracks' effects

#### Scenario: Muted track left out
- **WHEN** the Drums track is muted and the user downloads a WAV
- **THEN** the file has no drums

#### Scenario: Cancel
- **WHEN** the user cancels a render in progress
- **THEN** no file is downloaded and the song is unchanged

### Requirement: Project bundles with audio
When the open song has at least one entry in `samples`, "Download project" SHALL save a ZIP file named `<slug of song name>.songbird.zip` instead of a `.songbird.json` file. The ZIP SHALL hold:
- `project.json`, in the existing project-file format and version;
- one `audio/<sample id>.wav` per song sample, holding that sample's audio losslessly.

"Open project" SHALL accept `.songbird.zip` files of at most 2 GB as well as `.songbird.json` files, and SHALL validate `project.json` exactly as a `.songbird.json` file. A bundle SHALL be rejected, without changing the library, when:
- a sample's audio file is missing or unreadable;
- the audio's sample rate, channel count, or length differ from the sample's metadata.

A sample whose audio this browser already stores under the same id SHALL reuse the stored audio. Other samples SHALL be stored and added to the sample library. A song without samples SHALL still download as `.songbird.json`.

#### Scenario: Round trip with audio
- **WHEN** the user downloads a project with two samples and opens the bundle in another browser
- **THEN** the song opens with the same clips playing the same audio

#### Scenario: Missing audio file
- **WHEN** the user opens a bundle whose `project.json` refers to a sample with no matching file in `audio/`
- **THEN** the import is rejected with a message naming the sample, and the library is unchanged

### Requirement: Lyric meta-events in exported MIDI
For every note that a track's clips play and that carries a `lyric` (see `songwriting/topline`), the exported song MIDI file SHALL contain a Lyric meta-event (type `0x05`) in that note's MIDI track. The event SHALL be at the tick of the note's Note On, SHALL hold the lyric's text encoded as UTF-8, and SHALL come before that Note On. A note that plays more than once, because its clip repeats its loop, SHALL get an event every time it plays. A note that does not play SHALL get no event. Songs without lyrics on notes SHALL export exactly as before this requirement.

#### Scenario: Syllables become lyric events
- **WHEN** in a 4/4 song with no swing, a Vocal track's loop has notes carrying `hold` at step 0 and `me` at step 4, placed as one clip starting at measure 1
- **THEN** the Vocal MIDI track has a Lyric event `hold` at tick 0 before its Note On and a Lyric event `me` at tick 480 before its Note On

#### Scenario: Repeated clip repeats lyrics
- **WHEN** a 1-measure loop with one note carrying `la` at step 0 is placed as a 2-measure clip starting at measure 1 in 4/4
- **THEN** the track has Lyric events `la` at ticks 0 and 1920

#### Scenario: No lyrics, unchanged file
- **WHEN** a song whose notes carry no lyrics is exported
- **THEN** the file contains no Lyric meta-events and is byte-identical to the export before this requirement
