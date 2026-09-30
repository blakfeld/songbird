# Spec Delta

## MODIFIED Requirements

### Requirement: Instrument discovery
The system SHALL expose `GET /api/v1/instruments` returning `200` with a list of available instruments. Each instrument SHALL include:
- `id` and `name`.
- `kind`: `"drums"` or `"melodic"`.
- `midi_channel` (1–16).
- `midi_program`: a General MIDI program 1–128 for melodic instruments, `null` for drums.
- `range`: `{low, high}` MIDI notes for melodic instruments, `null` for drums.
- `sustained`: whether notes sound for their length or play as one-shots.
- `rows`: each with `id`, `name`, and MIDI `midi_note`, in display order.

In this change the list SHALL contain exactly the `drums` and `piano` instruments, in that order.

#### Scenario: Drums is listed
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the response contains an instrument with `id` `"drums"`, `kind` `"drums"`, `midi_channel` 10, `midi_program` null, `range` null, `sustained` false, and its drum rows

#### Scenario: Piano is listed
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the response contains an instrument with `id` `"piano"`, `kind` `"melodic"`, `midi_channel` 1, `midi_program` 1, `range` `{"low": 36, "high": 96}`, `sustained` true, and 61 pitch rows

#### Scenario: Exactly the offered instruments
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the instrument ids are exactly `["drums", "piano"]`

### Requirement: Pattern document format
A pattern document SHALL contain:
- `version`: integer, currently 1.
- `instrument`: the instrument id.
- `name`: a short human-readable title.
- `tempo_bpm`, `time_signature`, and `measures`.
- `steps_per_measure`: 16 for 4/4, 12 for 3/4, and 12 for 6/8, which is sixteenth-note resolution.
- `swing`.
- `midi_channel`: 1–16.
- `midi_program`: a General MIDI program 1–128, or `null` for instruments without one, such as drums.
- `rows`: a list of rows, each with `id`, `name`, and MIDI `midi_note`.
- `notes`: a list of `{row_id, step, length_steps, velocity}`, where `step` is a zero-based absolute step index, `length_steps` is an integer ≥ 1, and `velocity` is 1–127.

No note SHALL extend past the end of the pattern. No two notes on the same row SHALL overlap; a note occupies steps `step` through `step + length_steps − 1`. Notes on different rows MAY start at the same step.

A pattern submitted by a client without `midi_program` SHALL be accepted, and SHALL be treated as having its instrument's program. This keeps patterns saved before this field existed valid.

#### Scenario: Pattern is internally consistent
- **WHEN** any pattern is returned by the generate endpoint
- **THEN** every note references a row present in `rows`, every `velocity` is within 1–127, every `length_steps` is at least 1, every note ends within the pattern, and no two notes on the same row overlap

#### Scenario: Rows come from the instrument
- **WHEN** a pattern is generated for an instrument
- **THEN** its `rows`, `midi_channel`, and `midi_program` equal that instrument's rows, channel, and program as listed by `GET /api/v1/instruments`

#### Scenario: Older pattern without a program
- **WHEN** a client submits a drums pattern that has no `midi_program` field for MIDI export
- **THEN** it is accepted and exported exactly as before
