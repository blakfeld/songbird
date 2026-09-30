# Spec Delta

## Purpose

Defines the rules every pitched (melodic) instrument on Songbird's piano roll follows: its pitch rows, sustained notes, General MIDI program, and melodic generation behavior. It also holds the catalog of melodic instruments the service offers.

## ADDED Requirements

### Requirement: Pitch rows over a range
A melodic instrument SHALL have a pitch range (`low`–`high`, MIDI note numbers) and SHALL offer one row for every chromatic MIDI note in that range, inclusive, in display order from highest to lowest pitch. Each row's `midi_note` SHALL be its pitch, and its `id` and `name` SHALL be the pitch in scientific pitch notation with sharps for accidentals, where MIDI 60 is `C4` (for example `C4`, `C#4`, `A#2`). Every melodic pattern SHALL carry all of its instrument's rows, including rows with no notes.

#### Scenario: Piano rows span its range
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the `piano` instrument has 61 rows, the first with `id` `"C7"` and `midi_note` 96 and the last with `id` `"C2"` and `midi_note` 36

#### Scenario: Accidentals use sharps
- **WHEN** a client inspects the piano's row for MIDI note 61
- **THEN** its `id` and `name` are both `"C#4"`

### Requirement: Melodic catalog
The service SHALL offer these melodic instruments, each as `kind` `"melodic"`, `sustained` true, and MIDI channel 1:

| id | name | GM program | range |
|---|---|---|---|
| `piano` | Piano | 1 (Acoustic Grand Piano) | C2 (36) – C7 (96) |

#### Scenario: Piano definition
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** it contains an instrument with `id` `"piano"`, `name` `"Piano"`, `kind` `"melodic"`, `sustained` true, `midi_channel` 1, `midi_program` 1, and `range` `{"low": 36, "high": 96}`

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
