# Spec Delta

## MODIFIED Requirements

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
