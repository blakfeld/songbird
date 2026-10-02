# songs/sample-library Specification

## Purpose

Lets songwriters bring their own audio files into Songbird, keep them in one browsable library, and place them on audio tracks in any song.

## Requirements

### Requirement: Importing audio files
The Studio SHALL import audio files that are at most 200 MB and that decode to at most 20 minutes, from:
- an "Import audio…" action in the Samples panel and in an audio track's options menu;
- dropping files onto the Samples panel, an audio lane, or the empty area below the last lane.

A file SHALL be accepted when the browser can decode it. WAV, AIFF, MP3, AAC/M4A, and FLAC SHALL be supported in every supported browser. Each imported file SHALL become one sample:
- it is named after the file name without its extension, cut to 80 characters;
- it is decoded once and stored losslessly (see `songs/audio-tracks`, "Sample audio storage");
- it is added to the sample library.

Mono files SHALL stay mono. Files with more than two channels SHALL be mixed down to stereo. The import SHALL show progress per file. A file that fails SHALL be skipped with a message naming it and the reason (unsupported format, too large, too long, or not enough storage), and the other files SHALL still be imported.

#### Scenario: Import a WAV loop
- **WHEN** the user chooses "Import audio…" and picks `breakbeat-120.wav`
- **THEN** a sample named "breakbeat-120" appears in the library, and its preview plays the file

#### Scenario: Unsupported file skipped
- **WHEN** the user drops `notes.txt` and `kick.wav` together
- **THEN** "kick" is imported, and a message says `notes.txt` is not an audio file the browser can read

### Requirement: Placing samples on tracks
A sample SHALL become a clip of its full length, with loop off, gain 0 dB, and no fades, when:
- **Drop on a lane:** a sample dragged from the library, or an audio file dropped, onto an audio lane is placed where it was dropped, snapped to sixteenth steps unless Shift is held.
- **Keyboard:** pressing Enter, or choosing "Place at playhead", on a focused library sample places it on the selected audio track at the playhead.
- **Below the lanes:** dropping a sample or file below the last lane creates a new audio track named after the sample and places the clip there at the drop position.

A placement SHALL add the sample to the song's `samples` if it is not already there. A placement that would overlap an existing clip, or exceed the track or song limits, SHALL be refused with the reason, and the song SHALL be unchanged. A placement, including any new track and the import of a dropped file, SHALL be one undo step.

#### Scenario: Drag a sample to a lane
- **WHEN** the user drags "breakbeat-120" from the library onto the "Loops" lane at measure 5
- **THEN** a clip of "breakbeat-120" starts at measure 5 on "Loops"

#### Scenario: Drop a file below the lanes
- **WHEN** the user drops `vocal-chop.wav` below the last lane at measure 9
- **THEN** a new audio track "vocal-chop" is added with a clip at measure 9, and the sample is in the library

#### Scenario: Keyboard placement
- **WHEN** the "Loops" audio track is selected, the playhead is at measure 3, and the user focuses "kick" in the library and presses Enter
- **THEN** a clip of "kick" is placed on "Loops" at measure 3

#### Scenario: Overlap refused
- **WHEN** the user drops a sample onto a lane where it would overlap an existing clip
- **THEN** nothing is placed, and a message says the space is taken

### Requirement: Sample library panel
The Studio SHALL have a Samples panel, opened from the toolbar, that lists every sample in this browser's library, newest first. Each row SHALL show the name, length, and mono or stereo. The panel SHALL offer:
- **Search:** a box that filters by name, ignoring letter case.
- **Preview:** a button on each sample that plays it from the start through the main output, ignoring the song's mixer, and stops when pressed again or when another preview starts. Previews SHALL NOT interrupt song playback.
- **Rename:** changes the library name only. Songs keep the name they placed it with.
- **Remove from library:** removes the entry without changing any song. The panel SHALL say when songs still use the sample.

The library SHALL survive reloads, and it SHALL be per browser. It SHALL be keyboard-navigable, and each sample SHALL be draggable.

#### Scenario: Search
- **WHEN** the library has "kick-808", "Kick Acoustic", and "snare", and the user types "kick"
- **THEN** only "kick-808" and "Kick Acoustic" are listed

#### Scenario: Preview while playing
- **WHEN** the song is playing and the user previews "snare"
- **THEN** the snare is heard over the song, and the song keeps playing

#### Scenario: Remove a sample used by a song
- **WHEN** the user removes "breakbeat-120" from the library while a song uses it
- **THEN** it disappears from the library, and that song still plays it

### Requirement: Imported samples in other browsers
When a song or project bundle brings in a sample that isn't in this browser's library, its audio SHALL be stored and the sample SHALL be added to the library, so it can be reused in other songs.

#### Scenario: Bundle adds to the library
- **WHEN** the user opens a project bundle that uses "breakbeat-120" in a browser that has never seen it
- **THEN** the song plays the sample, and "breakbeat-120" appears in the library
