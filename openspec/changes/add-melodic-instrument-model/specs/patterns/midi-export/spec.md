# Spec Delta

## MODIFIED Requirements

### Requirement: MIDI file contents
The exported file SHALL be a Type 0 or Type 1 Standard MIDI File with a resolution of 480 ticks per quarter note. It SHALL contain:
- a tempo meta-event matching `tempo_bpm`;
- a time-signature meta-event matching `time_signature`;
- a track name;
- when the pattern has a `midi_program`, a Program Change on the pattern's `midi_channel` selecting that program, placed at tick 0 before any note;
- for each note, a Note On on the pattern's `midi_channel` at the row's `midi_note` with the note's velocity, followed by a matching Note Off at the start of step `step + length_steps`.

Swing SHALL be baked into note start and end times. The file SHALL end with an End of Track event placed at the end of the final measure, so the region length equals the pattern length. A pattern with no `midi_program` SHALL produce no Program Change.

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

#### Scenario: Melodic pattern selects its program
- **WHEN** a piano pattern (`midi_channel` 1, `midi_program` 1) with a `C4` note at step 0 is exported
- **THEN** the file contains a Program Change to General MIDI program 1 (wire value 0) on channel 1 at tick 0, before a Note On for note 60 on channel 1

#### Scenario: Drums have no program change
- **WHEN** a drums pattern is exported
- **THEN** the file contains no Program Change event

#### Scenario: Chords export as simultaneous notes
- **WHEN** a piano pattern with `C4`, `E4`, and `G4` at step 0, each of length 16, is exported
- **THEN** the file contains Note Ons for 60, 64, and 67 at tick 0 and their Note Offs at tick 1920

### Requirement: DAW compatibility
Exported files SHALL import into Logic Pro, either by dragging onto the tracks area or onto a Software Instrument or Drummer track. Drums notes SHALL land on the correct sounds of a General MIDI–mapped drum kit. Melodic notes SHALL land on their written pitches, and General MIDI players SHALL select the pattern's program. Exported files SHALL parse without errors in standard MIDI parsers.

#### Scenario: Round-trip parse
- **WHEN** an exported file is parsed by an independent MIDI parsing library
- **THEN** parsing succeeds and the recovered notes, velocities, start times, and durations match the pattern

#### Scenario: Round-trip parse of a melodic pattern
- **WHEN** an exported piano pattern is parsed by an independent MIDI parsing library
- **THEN** parsing succeeds, the recovered note numbers equal the rows' `midi_note` values, and the track's program is the pattern's `midi_program`
