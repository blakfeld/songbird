# Spec Delta

## Purpose

Defines the Drums instrument, the first instrument offered on Songbird's piano roll: its drum rows and General MIDI mapping, how it sounds, and the drum-specific musical behavior of generation.

## ADDED Requirements

### Requirement: Drum rows
The `drums` instrument SHALL use MIDI channel 10 and SHALL offer these rows, in this display order, each mapped to its General MIDI percussion note: Kick (36), Snare (38), Side Stick (37), Clap (39), Closed Hi-Hat (42), Pedal Hi-Hat (44), Open Hi-Hat (46), Low Tom (45), Mid Tom (47), High Tom (50), Crash (49), Ride (51). Every drums pattern SHALL carry all of these rows, including rows with no notes, so any sound can be added while editing.

#### Scenario: Required GM rows
- **WHEN** a drums pattern is generated
- **THEN** its `rows` include kick (36), snare (38), closed hi-hat (42), and open hi-hat (46), and its `midi_channel` is 10

#### Scenario: Silent rows are present
- **WHEN** a generated drums pattern has no ride notes
- **THEN** its `rows` still include the ride row

### Requirement: One-shot sound
The `drums` instrument SHALL be a one-shot (not sustained) instrument: each note plays its full drum sound regardless of `length_steps`. New drum notes SHALL default to `length_steps` 1.

#### Scenario: Length does not change drum playback
- **WHEN** a snare note's length is changed from 1 to 4 steps
- **THEN** playback of that note sounds the same full snare hit starting at the same time

### Requirement: Drum-appropriate generation
Generation for the `drums` instrument SHALL treat the description as a description of a drum groove, SHALL produce notes only on drum rows, and, when the AI output for a pattern longer than 4 measures contains no variation, SHALL insert a drum fill (such as a snare roll) at phrase ends.

#### Scenario: Fill inserted when missing
- **WHEN** the AI returns a single repeated groove for a 16-measure drums pattern
- **THEN** the last measure of each 4-measure phrase contains a fill that differs from measure 1

#### Scenario: Common drum shorthand accepted
- **WHEN** the AI output names rows with common shorthand such as `bd`, `hh`, or `oh`
- **THEN** the notes are placed on the kick, closed hi-hat, and open hi-hat rows respectively

### Requirement: Built-in drum kit
Playback of the `drums` instrument SHALL use a drum kit bundled with the application that has a sound for every drum row. It SHALL work without any external audio service or user-supplied samples.

#### Scenario: Offline playback
- **WHEN** the page is loaded and the network then becomes unavailable
- **THEN** the current drums pattern still plays with all rows audible
