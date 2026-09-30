# Spec Delta

## Purpose

Lets songwriters hear the current pattern in the browser with its instrument's sounds, with transport controls, so they can judge and refine it before exporting to their DAW.

## ADDED Requirements

### Requirement: Play and stop
The page SHALL provide Play and Stop controls (and the Space bar SHALL toggle play/stop when focus is not in a text field). Play SHALL start from the beginning of the pattern (or the loop start); Stop SHALL silence playback and reset the playhead.

#### Scenario: Play a pattern
- **WHEN** the user presses Play on a pattern with notes
- **THEN** the instrument's sounds are heard for each note in time order at the pattern's tempo

#### Scenario: Space toggles transport
- **WHEN** focus is on the piano roll and the user presses Space
- **THEN** playback starts, and pressing Space again stops it

### Requirement: Accurate timing
Playback SHALL start each note at `step × (60 / tempo_bpm) / 4` seconds from pattern start (sixteenth-note steps), with swing applied by delaying every odd-numbered sixteenth by `swing × (sixteenth duration)`. Timing SHALL NOT drift audibly over a 32-measure pattern.

#### Scenario: Steady tempo over long pattern
- **WHEN** a 32-measure 4/4 pattern plays at 120 BPM
- **THEN** the final measure begins 62 seconds (±20 ms) after playback starts

### Requirement: Note length
For a sustained instrument, each note SHALL sound until the start time of step `step + length_steps` (with swing applied to that step as above). For a one-shot instrument, each note SHALL play its full sound regardless of `length_steps`.

#### Scenario: One-shot ignores length
- **WHEN** a drums note has `length_steps` 4
- **THEN** it plays the full drum sound once at its start time

### Requirement: Looping
Playback SHALL loop the full pattern by default. The user SHALL be able to select a measure range to loop instead.

#### Scenario: Loop the whole pattern
- **WHEN** playback reaches the end of the pattern with looping on
- **THEN** it continues seamlessly from measure 1

#### Scenario: Loop a range
- **WHEN** the user sets the loop range to measures 5–8 and presses Play
- **THEN** only measures 5–8 play, repeating

### Requirement: Playhead
During playback the piano roll SHALL show a playhead at the current step and SHALL auto-scroll to keep it visible.

#### Scenario: Playhead follows playback
- **WHEN** a 32-measure pattern plays past the visible area
- **THEN** the piano roll scrolls so the playhead remains visible

### Requirement: Velocity and live edits are audible
Note loudness SHALL scale with velocity. Edits made during playback SHALL take effect no later than the next time the edited step is played.

#### Scenario: Add note while playing
- **WHEN** the user adds a note to a step while the pattern is looping
- **THEN** the new note is heard on the next pass over that step
