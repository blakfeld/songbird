# Spec Delta

## Purpose

Lets songwriters take a pattern out of Songbird as a Standard MIDI File that imports directly into Logic Pro and other DAWs.

## ADDED Requirements

### Requirement: Download as Standard MIDI File
The page SHALL provide a "Download MIDI" action that saves the current pattern (including unsaved edits) as a Standard MIDI File with the `.mid` extension, produced by `POST /api/v1/patterns/export/midi`.

#### Scenario: Download current pattern
- **WHEN** the user clicks "Download MIDI"
- **THEN** a `.mid` file is downloaded whose filename is derived from the pattern name and tempo (e.g. `songbird-boom-bap-90bpm.mid`)

### Requirement: MIDI file contents
The exported file SHALL be a Type 0 or Type 1 Standard MIDI File with a resolution of 480 ticks per quarter note, containing: a tempo meta-event matching `tempo_bpm`, a time-signature meta-event matching `time_signature`, a track name, and for each note a Note On on the pattern's `midi_channel` at the row's `midi_note` with the note's velocity, followed by a matching Note Off at the start of step `step + length_steps`. Swing SHALL be baked into note start and end times. The file SHALL end with an End of Track event placed at the end of the final measure so the region length equals the pattern length.

#### Scenario: Notes match the pattern
- **WHEN** a drums pattern with a kick (36) at step 0 velocity 110 and a snare (38) at step 4 velocity 90, both length 1, in 4/4 is exported
- **THEN** the file contains Note On for note 36 at tick 0 velocity 110 and Note On for note 38 at tick 480 velocity 90, both on channel 10, and the kick's Note Off is at tick 120

#### Scenario: Note length sets Note Off
- **WHEN** a note at step 0 with `length_steps` 8 and no swing is exported
- **THEN** its Note Off is at tick 960

#### Scenario: Region length is exact
- **WHEN** an 8-measure 4/4 pattern whose last note is in measure 6 is exported
- **THEN** the track's End of Track event is at tick 15360 (8 × 4 × 480)

#### Scenario: Tempo and meter
- **WHEN** a 3/4 pattern at 96 BPM is exported
- **THEN** the file contains a tempo event for 96 BPM and a 3/4 time-signature event

### Requirement: DAW compatibility
Exported files SHALL import into Logic Pro (by dragging onto the tracks area or onto a Software Instrument or Drummer track) with drums notes landing on the correct sounds of a General MIDI–mapped drum kit, and SHALL parse without errors in standard MIDI parsers.

#### Scenario: Round-trip parse
- **WHEN** an exported file is parsed by an independent MIDI parsing library
- **THEN** parsing succeeds and the recovered notes, velocities, start times, and durations match the pattern

### Requirement: Export matches playback
The notes, velocities, tempo, and swing in the exported file SHALL match what playback produces for the same pattern.

#### Scenario: Edited pattern exported
- **WHEN** the user removes a note and then exports
- **THEN** the removed note is absent from the file
