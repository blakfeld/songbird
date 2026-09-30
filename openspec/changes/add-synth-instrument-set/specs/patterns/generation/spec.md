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

The list SHALL contain exactly these instruments, in this order: `drums`, `piano`, `electric-piano`, `organ`, `bass`, `synth-lead`, `synth-pad`, `strings`, `pluck`.

#### Scenario: Drums is listed
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the response contains an instrument with `id` `"drums"`, `kind` `"drums"`, `midi_channel` 10, `midi_program` null, `range` null, `sustained` false, and its drum rows

#### Scenario: Piano is listed
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the response contains an instrument with `id` `"piano"`, `kind` `"melodic"`, `midi_channel` 1, `midi_program` 1, `range` `{"low": 36, "high": 96}`, `sustained` true, and 61 pitch rows

#### Scenario: Exactly the offered instruments
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the instrument ids are exactly `["drums", "piano", "electric-piano", "organ", "bass", "synth-lead", "synth-pad", "strings", "pluck"]`

#### Scenario: Every new instrument generates
- **WHEN** the service uses the mock provider and a client posts a generate request for each of the seven new instruments
- **THEN** each response is `200` with a pattern whose `instrument`, `rows`, `midi_channel`, and `midi_program` match that instrument's listing
