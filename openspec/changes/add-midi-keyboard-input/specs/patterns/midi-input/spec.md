# Spec Delta

## Purpose

Lets songwriters use a MIDI keyboard to play the current instrument live and to record what they play as notes, so that ideas are captured by performing them instead of clicking them in.

## ADDED Requirements

### Requirement: MIDI device access
The Studio page and each single-instrument editor page SHALL offer a MIDI input control on the transport.
- **Requesting access:** the page SHALL request MIDI access only when the user first activates the control. The request SHALL NOT ask for system-exclusive access.
- **Remembering the grant:** once access has been granted in this browser, later visits SHALL restore it without further input from the user, as long as the browser still grants it.
- **Choosing an input:** after access is granted, the control SHALL list every connected MIDI input by name, plus "All inputs", which is the default. The list SHALL update within one second when a device is connected or disconnected. The chosen input SHALL be remembered in this browser.
- **When the chosen input disappears:** if the chosen input is disconnected, the control SHALL say so, and input SHALL resume from that device when it reconnects.
- **Channels:** messages SHALL be accepted on all 16 MIDI channels.
- **Unavailable MIDI:** when the browser does not support Web MIDI, or the user denies access, the control SHALL say which of these happened. Record SHALL be disabled. Every other feature of the page SHALL keep working.

#### Scenario: Grant access and see devices
- **WHEN** a keyboard named "KeyStep" is connected and the user activates the MIDI input control and grants access
- **THEN** the control lists "All inputs" and "KeyStep", and "All inputs" is chosen

#### Scenario: Unsupported browser
- **WHEN** the page is opened in a browser without Web MIDI
- **THEN** the MIDI input control says MIDI keyboards are not supported in this browser, Record is disabled, and mouse editing and playback still work

#### Scenario: Hot-plug
- **WHEN** access is granted and the user plugs in a second keyboard
- **THEN** it appears in the list within one second

### Requirement: Playing the instrument live
While MIDI access is granted, a note-on message from the chosen input SHALL play the page's instrument right away.
- **Which instrument:** on a single-instrument page, it is that page's instrument. On the Studio page, it is the selected track's instrument, heard through that track's volume and pan.
- **Mute and solo:** a live note SHALL be audible even when its track is muted or soloed out, as a placed-note preview is.
- **Mapping keys to rows:** a MIDI note number SHALL play the instrument row with the same `midi_note`. A note number with no matching row SHALL be ignored.
- **Velocity:** the message's velocity (1–127) SHALL set the note's velocity.
- **Holding notes:** on a sustained instrument, a note SHALL sound until its note-off, or a note-on with velocity 0. While the sustain pedal (controller 64 at a value of 64 or more) is down, note-offs SHALL be held until the pedal is released. A one-shot instrument SHALL play its full sound on each note-on.
- **When it works:** live play SHALL work while the transport is stopped and while it is playing, and SHALL NOT change the pattern or song unless a take is being recorded.
- **Latency:** the page SHALL start the live note no more than 20 ms after it receives the message, not counting the browser's audio output latency.

#### Scenario: Play a melodic note
- **WHEN** the user on the piano page presses middle C (MIDI note 60) at velocity 90 and releases it after one second
- **THEN** the piano's `C4` row sounds at velocity 90 for about one second, and the pattern is unchanged

#### Scenario: Sustain pedal holds notes
- **WHEN** the user holds the sustain pedal, then presses and releases a key on a sustained instrument
- **THEN** the note keeps sounding until the pedal is released

#### Scenario: Studio plays the selected track
- **WHEN** the Bass track is selected in the Studio and the user plays a key
- **THEN** it sounds with the Bass track's instrument, volume, and pan

#### Scenario: Key outside the instrument
- **WHEN** the drums instrument has no row with MIDI note 30 and the user presses note 30
- **THEN** nothing sounds and nothing is recorded

### Requirement: Recording a take
The transport SHALL offer a Record toggle. The `R` key SHALL activate it when focus is not in a text field and no dialog is open. Record SHALL be disabled until MIDI access is granted.
- **Starting from stopped:** starting Record while the transport is stopped SHALL start the count-in first, if it is on (see `patterns/playback` "Metronome and count-in"). It SHALL then start playback and recording together, at the measure where Play would start.
- **Punching in:** starting Record while playing SHALL begin recording at once.
- **Ending the take:** turning Record off SHALL end the take and leave playback running. Stop SHALL end the take and stop playback. With looping off, the take SHALL end when playback stops by itself at the end.
- **Showing the state:** while recording, the Record control SHALL show that it is recording, and the page SHALL announce the start and end of the take to assistive technology.
- **Quantizing:** each recorded note's `step` SHALL be the sixteenth step whose playback time is closest to the note-on. Swing SHALL be taken into account. Its `length_steps` SHALL be the number of steps from that start to the step closest to the note-off, and at least 1. On a one-shot instrument, `length_steps` SHALL be 1. `velocity` SHALL be the note-on velocity.
- **Wrapping at the end of the loop:** a note that ends past the end of the range being played SHALL be shortened to end there. A note-on that rounds to the step just after the end of the range SHALL be recorded on the region's first step while looping is on, and SHALL be discarded while looping is off.
- **Merging:** recorded notes SHALL be merged with existing notes.
  - A recorded note that starts on the same row and step as an existing note SHALL replace it.
  - Where notes on the same row would overlap, the earlier note SHALL be shortened to end where the later one starts.
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

#### Scenario: Punch in and out
- **WHEN** playback is running in measure 3 and the user presses `R`, plays for two bars, and presses `R` again
- **THEN** only the notes played between the two presses are recorded, and playback keeps running

#### Scenario: One take, one undo
- **WHEN** the user records a take of 12 notes across three loop passes and presses Cmd/Ctrl+Z
- **THEN** all 12 notes are removed, and the notes that were there before the take are unchanged

#### Scenario: Stop during count-in
- **WHEN** the user presses Stop during the count-in
- **THEN** nothing is recorded and playback does not start
