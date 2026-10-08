# instruments/melodic Specification

## Purpose

Defines the rules every pitched (melodic) instrument on Songbird's piano roll follows: its pitch rows, sustained notes, General MIDI program, and melodic generation behavior. It also holds the catalog of melodic instruments the service offers.

## Requirements

### Requirement: Pitch rows over a range
A melodic instrument SHALL have a pitch range (`low`–`high`, MIDI note numbers) and SHALL offer one row for every chromatic MIDI note in that range, inclusive, in display order from highest to lowest pitch. Each row's `midi_note` SHALL be its pitch, and its `id` and `name` SHALL be the pitch in scientific pitch notation with sharps for accidentals, where MIDI 60 is `C4` (for example `C4`, `C#4`, `A#2`). Every melodic pattern SHALL carry all of its instrument's rows, including rows with no notes.

#### Scenario: Piano rows span its range
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the `piano` instrument has 61 rows, the first with `id` `"C7"` and `midi_note` 96 and the last with `id` `"C2"` and `midi_note` 36

#### Scenario: Accidentals use sharps
- **WHEN** a client inspects the piano's row for MIDI note 61
- **THEN** its `id` and `name` are both `"C#4"`

### Requirement: Melodic catalog
The service SHALL offer these melodic instruments, in this order, each as `kind` `"melodic"`, `sustained` true, and MIDI channel 1:

| id | name | GM program | range |
|---|---|---|---|
| `piano` | Piano | 1 (Acoustic Grand Piano) | C2 (36) – C7 (96) |
| `electric-piano` | Electric Piano | 5 (Electric Piano 1) | C2 (36) – C6 (84) |
| `organ` | Organ | 17 (Drawbar Organ) | C2 (36) – C6 (84) |
| `bass` | Bass | 34 (Electric Bass, finger) | E1 (28) – G3 (55) |
| `synth-lead` | Synth Lead | 81 (Lead 1, square) | C3 (48) – C6 (84) |
| `synth-pad` | Synth Pad | 89 (Pad 1, new age) | C2 (36) – C6 (84) |
| `strings` | Strings | 49 (String Ensemble 1) | C2 (36) – C6 (84) |
| `pluck` | Pluck | 46 (Pizzicato Strings) | C3 (48) – C6 (84) |
| `vocal` | Vocal Guide | 54 (Voice Oohs) | E2 (40) – C6 (84) |

#### Scenario: Piano definition
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** it contains an instrument with `id` `"piano"`, `name` `"Piano"`, `kind` `"melodic"`, `sustained` true, `midi_channel` 1, `midi_program` 1, and `range` `{"low": 36, "high": 96}`

#### Scenario: Bass definition
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** it contains an instrument with `id` `"bass"`, `midi_program` 34, `range` `{"low": 28, "high": 55}`, and 28 rows from `G3` down to `E1`

#### Scenario: Vocal Guide definition
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the last melodic instrument has `id` `"vocal"`, `name` `"Vocal Guide"`, `midi_program` 54, `range` `{"low": 40, "high": 84}`, and 45 rows from `C6` down to `E2`

#### Scenario: Every catalog instrument has an editor page
- **WHEN** the user opens `/instruments/synth-pad`
- **THEN** the pattern editor titled "Synth Pad" is shown with rows from `C6` down to `C2`

### Requirement: Sustained melodic notes
Every melodic instrument SHALL be sustained: a note sounds from its start until the start of step `step + length_steps`. Several notes MAY sound at the same step on different rows (chords). Notes on the same row SHALL NOT overlap, as with every instrument.

#### Scenario: Chord in a pattern
- **WHEN** a piano pattern contains notes on rows `C4`, `E4`, and `G4` at step 0
- **THEN** the pattern is valid and all three notes are kept

### Requirement: Melodic generation
Generation for a melodic instrument SHALL treat the description as a description of a part for that instrument (melody, chords, or both) and SHALL produce notes only on the instrument's pitch rows. Pitch lanes in the AI output SHALL be accepted in scientific pitch notation with sharps or flats, in any letter case (for example `C#4`, `Db4`, `db4`), or as MIDI note numbers. A pitch outside the instrument's range SHALL be moved by whole octaves to the nearest octave inside the range. A pitch that no octave shift can bring into range SHALL be dropped. If moving pitches creates a duplicate note, the louder one SHALL be kept.

#### Scenario: Flat names resolve to sharp rows
- **WHEN** the AI output for a piano pattern has a lane named `Bb3`
- **THEN** its notes are placed on the `A#3` row

#### Scenario: MIDI numbers are accepted
- **WHEN** the AI output for a piano pattern has a lane named `60`
- **THEN** its notes are placed on the `C4` row

#### Scenario: Out-of-range pitch is folded by octaves
- **WHEN** the AI output for a piano pattern has notes on `E8` (MIDI 100)
- **THEN** those notes are placed on the `E6` row (MIDI 88), the highest `E` in range

#### Scenario: Unknown lane is dropped
- **WHEN** the AI output for a piano pattern has a lane named `kick`
- **THEN** no notes from that lane appear in the pattern

### Requirement: Melodic phrase-end variation
When the AI output for a melodic pattern longer than 4 measures contains no variation, the system SHALL insert a deterministic melodic variation at the last measure of every 4-measure phrase. The variation SHALL differ from the pattern's first measure and SHALL use only the instrument's rows.

#### Scenario: Variation inserted for repeated piano part
- **WHEN** the AI returns a single repeated one-measure piano part for an 8-measure pattern
- **THEN** measures 4 and 8 differ from measure 1, and every note is on a piano row

#### Scenario: Whole-note chord still varies
- **WHEN** the AI returns one C major chord held for the whole measure, repeated for 16 measures
- **THEN** measures 4, 8, 12, and 16 differ from measure 1

### Requirement: General MIDI program
Every melodic instrument SHALL declare a General MIDI program number (1–128). Its patterns SHALL carry that program as `midi_program`, and MIDI export SHALL select it so a DAW's General MIDI instrument plays a matching sound.

#### Scenario: Piano pattern carries its program
- **WHEN** a piano pattern is generated
- **THEN** its `midi_program` is 1

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

### Requirement: Monophonic generation
Generation for the `bass`, `synth-lead`, and `vocal` instruments SHALL produce a single melodic line:
- When the AI output has more than one note starting at the same step, only the lowest note (for `bass`) or the highest note (for `synth-lead` and `vocal`) SHALL be kept.
- A kept note SHALL be shortened so it ends no later than the start of the next kept note.

This rule applies only to generated patterns. The user SHALL still be able to add simultaneous notes by hand.

#### Scenario: Bass keeps the lowest note
- **WHEN** the AI output for a bass pattern has `C2` and `G2` both starting at step 0
- **THEN** the generated pattern has only the `C2` note at step 0

#### Scenario: Lead keeps the highest note
- **WHEN** the AI output for a synth-lead pattern has `E4` and `C5` both starting at step 8
- **THEN** the generated pattern has only the `C5` note at step 8

#### Scenario: Vocal keeps the highest note
- **WHEN** the AI output for a vocal pattern has `A3` and `E4` both starting at step 0
- **THEN** the generated pattern has only the `E4` note at step 0

#### Scenario: Line notes do not overlap
- **WHEN** the AI output for a bass pattern has `C2` at step 0 with length 8 and `F2` at step 4
- **THEN** the generated `C2` note has length 4

#### Scenario: Hand-entered chord on bass
- **WHEN** the user adds `C2` and `G2` at the same step on the bass page
- **THEN** both notes remain in the pattern and both play

### Requirement: Distinct synth voices
Each melodic instrument's built-in synthesizer voice SHALL match its character:
- `electric-piano`: a bell-like attack that decays.
- `organ`: a steady tone with no decay while held.
- `bass`: low-register emphasis with a quick attack.
- `synth-lead`: a bright, sustained tone.
- `synth-pad`: a slow attack and long release.
- `strings`: a moderate attack and sustained tone.
- `pluck`: a sharp attack that decays to silence within about one second, even when the note is longer.
- `vocal`: a soft attack and a rounded, vowel-like tone with gentle vibrato, sustained while held.

#### Scenario: Organ holds its level
- **WHEN** an organ note 16 steps long plays at 120 BPM
- **THEN** its loudness stays constant from the end of its attack until its release

#### Scenario: Pluck decays within a long note
- **WHEN** a pluck note 32 steps long plays at 120 BPM
- **THEN** it is inaudible well before its scheduled release at 4 seconds

#### Scenario: Pad has a slow attack
- **WHEN** a synth-pad note starts
- **THEN** it reaches full level noticeably later than a piano note of the same velocity

#### Scenario: Vocal sustains with vibrato
- **WHEN** a vocal note 16 steps long plays at 120 BPM
- **THEN** it keeps sounding until its release, and its pitch varies slightly and periodically around the note's pitch
