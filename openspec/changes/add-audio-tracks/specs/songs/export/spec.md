## MODIFIED Requirements

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

## ADDED Requirements

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
