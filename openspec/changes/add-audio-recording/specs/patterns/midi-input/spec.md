## MODIFIED Requirements

### Requirement: Recording a take
The transport SHALL offer a Record toggle. The `R` key SHALL activate it when focus is not in a text field and no dialog is open. Record SHALL be disabled until MIDI access is granted, except in the Studio while the selected track is an audio track, where Record records audio from the track's input (see `songs/audio-recording`) and needs microphone access instead.
- **Starting from stopped:** starting Record while the transport is stopped SHALL start the count-in first, if it is on (see `patterns/playback` "Metronome and count-in"). It SHALL then start playback and recording together, at the measure where Play would start.
- **Punching in:** starting Record while playing SHALL begin recording at once.
- **Ending the take:** turning Record off SHALL end the take and leave playback running. Stop SHALL end the take and stop playback. With looping off, the take SHALL end when playback stops by itself at the end, except for an audio take in the Studio, which keeps playing and recording past the end of the song (see `songs/audio-recording`, "Recording audio takes").
- **Showing the state:** while recording, the Record control SHALL show that it is recording, and the page SHALL announce the start and end of the take to assistive technology.
- **Quantizing:** each recorded note's `step` SHALL be the sixteenth step whose playback time is closest to the note-on. Swing SHALL be taken into account. Its `length_steps` SHALL be the number of steps from that start to the step closest to the note-off, and at least 1. On a one-shot instrument, `length_steps` SHALL be 1. `velocity` SHALL be the note-on velocity.
- **Wrapping at the end of the loop:** a note that ends past the end of the range being played SHALL be shortened to end there. A note-on that rounds to the step just after the end of the range SHALL be recorded on the region's first step while looping is on, and SHALL be discarded while looping is off.
- **Merging:** recorded notes SHALL be merged with existing notes.
  - A recorded note that starts on the same row and step as an existing note SHALL replace it.
  - An existing note on the same row that a recorded note overlaps SHALL be shortened to end where the recorded note starts, and SHALL be removed if nothing of it would remain. This is the same rule as pasting notes (see `patterns/piano-roll-editor`).
  - Recorded notes SHALL be merged in the order they start, so a later recorded note also shortens an earlier recorded one it overlaps.
- **Cycling:** while looping is on, recording SHALL continue through every pass of the loop region. Notes recorded on one pass SHALL be heard on the next pass.
- **Showing notes:** recorded notes SHALL appear in the piano roll, and in the Studio in the lane overview, no later than 100 ms after their note-off.
- **Undo:** a take SHALL be recorded as one undo step.
- **Where notes go on single-instrument pages:** into the page's pattern. The pattern's length SHALL NOT change.
- **Where notes go in the Studio:** see `songs/clips` "Recording onto the Studio timeline".

#### Scenario: Record from stopped with count-in
- **WHEN** looping is off, the count-in is on, and the user presses Record on an 8-measure pattern
- **THEN** one bar of clicks is heard, then playback and recording start at measure 1, and the take ends when playback stops after measure 8

#### Scenario: Quantized to the nearest step
- **WHEN** at 120 BPM with no swing the user presses a key 30 ms after step 4 and releases it 250 ms later
- **THEN** a note is recorded at step 4 with `length_steps` 2

#### Scenario: Early downbeat on a loop pass
- **WHEN** looping is on over measures 1–2, and the user hits a key 20 ms before the loop wraps back to measure 1
- **THEN** the note is recorded on the first step of measure 1

#### Scenario: Overdub a drum beat
- **WHEN** a drum pattern has kicks and the user records snares over two passes of the loop
- **THEN** the kicks are kept, the snares are added, and the snares from the first pass are heard during the second pass

#### Scenario: Same step replaces
- **WHEN** a `C4` note at step 0 has velocity 100 and the user records `C4` at step 0 with velocity 60
- **THEN** there is exactly one `C4` note at step 0, and its velocity is 60

#### Scenario: A recorded note shortens an overlapped note
- **WHEN** a `C4` note starts at step 0 and lasts 8 steps, and the user records `C4` at step 4
- **THEN** the existing note lasts 4 steps, and the recorded note starts at step 4

#### Scenario: Punch in and out
- **WHEN** playback is running in measure 3 and the user presses `R`, plays for two bars, and presses `R` again
- **THEN** only the notes played between the two presses are recorded, and playback keeps running

#### Scenario: One take, one undo
- **WHEN** the user records a take of 12 notes across three loop passes and presses Cmd/Ctrl+Z
- **THEN** all 12 notes are removed, and the notes that were there before the take are unchanged

#### Scenario: Stop during count-in
- **WHEN** the user presses Stop during the count-in
- **THEN** nothing is recorded and playback does not start

#### Scenario: Record on an audio track without MIDI
- **WHEN** MIDI access has not been granted and the selected Studio track is an audio track
- **THEN** Record is enabled and records audio
