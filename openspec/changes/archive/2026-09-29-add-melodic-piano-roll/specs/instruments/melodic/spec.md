# Spec Delta

## ADDED Requirements

### Requirement: Built-in synthesized sound
Playback of every melodic instrument SHALL use a synthesizer built into the application, with no samples, external audio service, or network access required. Each melodic instrument SHALL have its own voice. The `piano` voice SHALL have a fast attack and a decaying sustain.

The synthesizer SHALL:
- scale loudness with velocity;
- start each note at its scheduled start time;
- release it at its scheduled end (the start of step `step + length_steps`);
- play at least 32 notes at once.

When more notes are requested at once, the oldest sounding note SHALL be released to make room, unless every sounding note started at the same instant as the new note or later, in which case the new note SHALL NOT be played.

#### Scenario: Offline melodic playback
- **WHEN** the piano page is loaded and the network then becomes unavailable
- **THEN** the current piano pattern still plays with every note audible

#### Scenario: Chords sound together
- **WHEN** a piano pattern with `C4`, `E4`, and `G4` at step 0 is played
- **THEN** all three pitches start together

#### Scenario: More simultaneous notes than voices
- **WHEN** a piano pattern with 33 notes at step 0 and no earlier notes is played
- **THEN** 32 of them sound, and playback continues without error

#### Scenario: Notes release at their end
- **WHEN** a piano note with `length_steps` 8 plays at 120 BPM with no swing
- **THEN** it is released 1 second after it starts

#### Scenario: Stop silences held notes
- **WHEN** the user presses Stop while a long piano note is sounding
- **THEN** the note is silenced
