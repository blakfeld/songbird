# Spec Delta

## Purpose

Lets songwriters capture an idea the way they first have it, by humming a melody or tapping a beat, and turns it into notes on a track. The notes sit in time with the song and can be edited like any other part.

## ADDED Requirements

### Requirement: Capture panel
The Studio SHALL offer a "Capture idea" control in the transport. It SHALL open a capture panel with three modes:
- **Hum:** a sung or hummed melody becomes notes on a melodic track.
- **Tap:** taps, claps, or beatboxing become drum notes.
- **Keys:** computer-key taps become drum notes.

The last mode used SHALL be remembered in this browser.

**Target:** the panel SHALL let the user choose where the result goes:
- **New track**, the default. A Hum capture creates a Piano track by default, and the user MAY choose any melodic instrument. A Tap or Keys capture creates a Drums track.
- **The selected track**, offered only when the selected track is a melodic track (for Hum) or a drums track (for Tap and Keys).

**Input:** the panel SHALL offer an input picker for Hum and Tap that lists the browser's audio input devices. The choice SHALL be remembered in this browser and not saved in the song. Microphone permission SHALL be requested the first time the user starts a Hum or Tap capture, following the same permission and denial rules as audio recording (see `songs/audio-recording`, "Audio input selection"). When permission is denied, Hum and Tap SHALL be unavailable with the reason shown, and Keys SHALL remain available.

The panel SHALL NOT be offered on the single-instrument pages.

#### Scenario: Open in Hum mode
- **WHEN** the user opens the capture panel for the first time and no track is selected
- **THEN** the panel is in Hum mode, and its target is a new Piano track

#### Scenario: Selected drums track offered for Tap
- **WHEN** the Drums track is selected and the user switches the panel to Tap
- **THEN** "Drums" is offered as a target besides "New track"

#### Scenario: Microphone denied
- **WHEN** the user denies microphone access from the capture panel
- **THEN** the panel explains how to allow it, Hum and Tap cannot be started, and Keys can

### Requirement: Capturing in time
Pressing Capture SHALL play one measure of count-in clicks. Playback and capture SHALL then start together at the first step of the measure under the playhead.
- **Click:** the metronome SHALL click during capture, unless the panel's Click toggle is off. The toggle is on by default and remembered in this browser.
- **Other tracks:** they SHALL play as in normal playback, unless the panel's "Play song" toggle is off. That toggle is also on by default.
- **Loop region:** capture SHALL ignore the loop region and play straight through.
- **Ending:** capture SHALL end when the user presses Stop or Capture again, or after 32 measures. The captured range SHALL run from the start measure to the end of the measure in which capture ended. Capture SHALL continue past the end of the song.
- **Timing:** sounds SHALL be placed at the song time at which they were heard. Hum and Tap captures SHALL be shifted earlier by the output and input latencies that the browser reports plus the recording offset, as audio takes are (see `songs/audio-recording`, "Recording audio takes" and "Recording offset"). Keys captures SHALL be shifted earlier by the output latency plus the recording offset only.
- **Feedback:** while capturing, the panel SHALL show the input level for Hum and Tap. In Hum mode, it SHALL also show the name of the note currently detected, or a rest marker when no pitch is detected. Each Keys tap SHALL be heard as its drum sound.
- **Refusing a capture:** a capture SHALL be refused before it starts, with the reason given, when committing its result could not fit the song's track, sample, or take limits.
- **Leaving the song alone:** capturing SHALL NOT change the song.

#### Scenario: Capture four measures
- **WHEN** the playhead is in measure 5, the user presses Capture, hums for four measures, and presses Stop during measure 9
- **THEN** one measure of count-in is heard, capture starts at measure 5, and the captured range is measures 5–9

#### Scenario: Automatic end
- **WHEN** the user captures without pressing Stop
- **THEN** capture ends by itself after 32 measures

#### Scenario: Latency compensated
- **WHEN** the browser reports 10 ms of output latency and 8 ms of input latency, and the user claps exactly on the beat of the second captured measure in Tap mode
- **THEN** the resulting hit is detected within 10 ms of the start of that measure, before any clean-up

### Requirement: Captured audio stays in the browser
Pitch detection, onset detection, and sound classification SHALL run in the browser. No request made by the capture feature SHALL carry captured audio, or features derived from it, to the server or to any AI provider. Capturing and converting SHALL work with the network unavailable. Captured audio SHALL be discarded when the panel is closed, the capture is retaken, or the result is committed without keeping the original. It SHALL be stored only when it is kept as the original recording (see "Committing a captured idea"), and then only under the same storage rules as other recorded samples (see `songs/audio-tracks`, "Sample audio storage").

#### Scenario: Offline capture
- **WHEN** the network is unavailable and the user captures and commits a hummed melody
- **THEN** the notes appear on the track, and no network request is made during capture, conversion, or commit

#### Scenario: Cancelled capture leaves nothing behind
- **WHEN** the user captures, then closes the panel without committing
- **THEN** the captured audio is not in the song, the sample library, or the browser's sample store

### Requirement: Hum to notes
In Hum mode, the captured audio SHALL be converted to a single line of notes with no two notes overlapping.
- **Pitch range:** pitches from C2 (MIDI 36) to C6 (MIDI 84) SHALL be detected. For a steady sung or synthesized tone held at least 100 ms, the detected note SHALL be that tone's nearest semitone.
- **Unpitched sound:** silence, breath, and noise SHALL produce no notes.
- **Note boundaries:** a new note SHALL begin at the following points:
  - after a rest;
  - at a change of pitch held for at least 60 ms;
  - at a fresh attack on the same pitch, such as a re-sung syllable.

  Vibrato and slides of less than a semitone around a held pitch SHALL NOT split a note.
- **Octave errors:** an isolated jump of exactly an octave that lasts less than 60 ms SHALL be treated as the surrounding pitch.
- **Instrument range:** when the line does not fit the target instrument's range, the whole line SHALL be moved by whole octaves to put as many notes as possible inside the range, preferring the octave nearest the sung pitch. Notes that still fall outside SHALL be moved by octaves to the nearest in-range pitch.
- **Velocity:** each note's velocity SHALL follow its loudness relative to the loudest note of the capture, from 50 to 110.

#### Scenario: Three sung notes
- **WHEN** at 120 BPM in 4/4 the user sings A3, C4, and E4 as quarter notes on beats 1, 2, and 3 of the first captured measure
- **THEN** the preview holds A3, C4, and E4 starting on steps 0, 4, and 8 of the captured range, each 4 steps long or shorter

#### Scenario: Vibrato stays one note
- **WHEN** the user holds A3 for two beats with ±40 cents of vibrato
- **THEN** one A3 note is produced

#### Scenario: Repeated syllables
- **WHEN** the user sings "da da da" on the same G3, one beat each with brief breaks
- **THEN** three G3 notes are produced

#### Scenario: Low voice on a lead instrument
- **WHEN** the user hums a melody between A2 and E3 with Synth Lead (C3–C6) as the target
- **THEN** the notes are moved up one octave, and the melody's shape is unchanged

### Requirement: Tap to drums
In Tap mode, each distinct hit in the captured audio SHALL become one drum note on one of the following rows:
- Kick (36) for low, thumping sounds, such as a "b" or "boom", or a fist on a table;
- Snare (38) for broad, mid-range sounds, such as a "k", "psh", or a clap;
- Closed Hi-Hat (42) for short, bright sounds, such as a "ts" or "t";
- Open Hi-Hat (46) for bright sounds that ring for at least 120 ms, such as a long "tsss".

Two hits less than 40 ms apart SHALL count as one. Each note's velocity SHALL follow the hit's strength relative to the strongest hit of the capture, from 40 to 127.

**Sensitivity:** a Sensitivity control from 0 to 100, default 50, SHALL set how weak a hit can be and still count. Raising it SHALL never remove a hit that a lower setting kept.

**Click bleed:** when the click is on, sounds that coincide with a click and are weaker than the capture's typical hit SHALL be ignored, so that a click heard through speakers does not become hits.

#### Scenario: Basic beatbox
- **WHEN** at 100 BPM the user beatboxes "boom ts k ts" as eighth notes for one measure
- **THEN** the preview holds Kick on step 0, Closed Hi-Hat on steps 2 and 6, and Snare on step 4

#### Scenario: Long hat
- **WHEN** the user makes a "tsss" sound lasting 300 ms on beat 1
- **THEN** an Open Hi-Hat note is produced on step 0

#### Scenario: Sensitivity is monotonic
- **WHEN** a capture shows 12 hits at Sensitivity 50 and the user raises Sensitivity to 80
- **THEN** at least those 12 hits are shown

### Requirement: Tapping on keys
In Keys mode, while capturing, the following keys SHALL each record a hit on a drum row and play that row's sound:
- `F` or Space: Kick;
- `J`: Snare;
- `K`: Closed Hi-Hat;
- `L`: Open Hi-Hat.

Every hit SHALL have velocity 100. Key repeat from a held key SHALL be ignored. While a Keys capture runs, these keys SHALL NOT trigger any other Studio shortcut. The panel SHALL show this mapping.

#### Scenario: Tap a rock beat
- **WHEN** at 120 BPM the user presses `F` on beats 1 and 3, `J` on beats 2 and 4, and `K` on every eighth note of one measure
- **THEN** the preview holds Kick on steps 0 and 8, Snare on steps 4 and 12, and Closed Hi-Hat on every even step

#### Scenario: Held key
- **WHEN** the user holds `J` for one second
- **THEN** one Snare hit is recorded

### Requirement: Clean-up and preview
After a capture, the panel SHALL show the result over the captured range, on a grid like the piano roll's, before anything is written to the song. It SHALL offer these controls:
- **Grid:** 1/16, 1/8, or 1/4. The default is 1/16.
- **Clean-up:** from 0 to 100%, default 50%. Clean-up SHALL affect the result in three ways:
  - **Timing:** each note's start SHALL move toward its nearest grid line by the Clean-up percentage of the distance, and then round to the nearest sixteenth step, taking swing into account as recorded MIDI notes do (see `patterns/midi-input`, "Recording a take"). At 100%, every start SHALL lie on the grid.
  - **Blips (Hum):** notes shorter than a threshold SHALL be removed. The threshold rises with Clean-up, from 40 ms at 0% to one grid unit at 100%.
  - **Gaps (Hum):** a note SHALL be extended to the next note's start when the gap between them is shorter than the Clean-up percentage of one grid unit.
  
  On the drums rows, two hits on the same row and step SHALL be merged into one, keeping the louder.
- **Note ends:** in Hum mode, each note's end SHALL round to the nearest sixteenth step, and each note SHALL last at least one step. In Tap and Keys mode, each note SHALL be 1 step long.
- **Snap to key (Hum):** on by default. It SHALL move every pitch outside the song's key to the nearest pitch in the key. When two key pitches are equally near, it SHALL move to the one nearer the sung pitch, and then downward.
- **Sensitivity (Tap):** see "Tap to drums".

Changing any control SHALL update the preview within 100 ms, without capturing again.

**Listening:** Play SHALL loop the captured range with the result on the target instrument, together with the song when "Play song" is on. An "Original" toggle SHALL play the captured audio in place of the result, at its compensated position, so the two can be compared.

**Retake** SHALL discard the capture and start a new one with the same settings. When the result has no notes, the panel SHALL say that nothing was detected, and Commit SHALL be disabled.

#### Scenario: Full clean-up locks to the grid
- **WHEN** Grid is 1/8, Clean-up is 100%, and a hummed note starts one sixteenth after beat 2
- **THEN** the note starts on an eighth-note grid line

#### Scenario: No clean-up keeps the feel
- **WHEN** Clean-up is 0% and a hummed note starts 20 ms after step 5 at 120 BPM
- **THEN** the note starts on step 5

#### Scenario: Snap to key
- **WHEN** the song is in C major, Snap to key is on, and the user sings a slightly sharp F#3 between F3 and G3
- **THEN** the note becomes G3, and with Snap to key off it is F#3

#### Scenario: Instant update
- **WHEN** the user drags the Clean-up slider
- **THEN** the preview changes as the slider moves, and no new capture starts

#### Scenario: Compare with the original
- **WHEN** the user turns on Original and presses Play
- **THEN** the captured audio is heard over the captured range in place of the converted notes

### Requirement: Committing a captured idea
Commit SHALL write the result into the target track over the captured range. The result SHALL become one new loop exactly as long as the range, placed as one clip covering it, under the same rules as writing a generated range (see `songs/track-generation`), as follows:
- the target track's clips in the range SHALL be shortened, split, or removed;
- existing loops SHALL NOT be changed.

**Naming:** the loop SHALL be named "Hummed idea" or "Tapped beat". A new track SHALL get the same name, with a number added when that name is already taken.

**Keep original:** a "Keep original" option, on by default for Hum and Tap and unavailable for Keys, SHALL also keep the captured audio:
- it SHALL be stored as a recorded sample (see `songs/audio-recording`, "Recorded samples in the song document");
- it SHALL be placed as one audio clip at its compensated position on a new audio track, named after the target track with " (voice)" added;
- that track SHALL be placed directly below the target track and SHALL be muted.

**Undo and the song's length:** the whole commit, including any new tracks, the loop, the clip, and the kept recording, SHALL be one undo step. The song's length SHALL follow the new clips as for any clip edit. After a commit, the panel SHALL close and the new clip SHALL be selected and open in the editor dock.

**Limits:** when the commit would exceed the 16-track limit, Commit SHALL be refused with the reason given. If keeping the original is what would exceed the limit, the panel SHALL say that unchecking "Keep original" allows the commit.

#### Scenario: Hum into a new track
- **WHEN** the user captures a hummed melody over measures 5–8 with target "New track" (Piano) and Keep original on, and commits
- **THEN** a "Hummed idea" Piano track with one clip over measures 5–8 is added, followed by a muted "Hummed idea (voice)" audio track whose clip plays the recording, and one Cmd/Ctrl+Z removes both

#### Scenario: Tap into the existing drums
- **WHEN** a Drums track has a clip of "Groove A" covering measures 1–8, and the user commits a tapped beat over measures 3–4 into it
- **THEN** the Drums track plays "Groove A" in measures 1–2 and 5–8 and the new "Tapped beat" loop in measures 3–4, and "Groove A"'s notes are unchanged

#### Scenario: Result is ordinary music
- **WHEN** the user commits a capture and opens its clip
- **THEN** its notes can be moved, resized, deleted, and played like any other clip's notes

#### Scenario: Track limit
- **WHEN** the song has 15 tracks and the user commits a hummed capture to a new track with Keep original on
- **THEN** Commit is refused with a message that unchecking "Keep original" allows it

### Requirement: Build around a captured idea
After a commit, the Studio SHALL offer a "Build around this" action for the committed track. The action SHALL do the following:
- open the song chat with its input prefilled with `Build a part around "<track name>"`, which the user can edit before sending;
- attach the committed track as the anchor for the next message only (see `songs/track-generation`, "Anchor track in song chat");
- show the anchor in the chat input with a control to remove it.

The action SHALL NOT send anything until the user sends the message.

#### Scenario: Build drums around a hum
- **WHEN** the user commits a "Hummed idea" track over measures 1–8, chooses "Build around this", edits the message to "add drums around this", and sends it
- **THEN** a drums track is added with a clip over measures 1–8, and the request named "Hummed idea" as the anchor

#### Scenario: Remove the anchor
- **WHEN** the user removes the anchor from the chat input before sending
- **THEN** the message is sent without an anchor
