# Spec Delta

## Purpose

Turns a songwriter's plain-language description, plus musical parameters and a chosen instrument, into a structured, validated note pattern that the piano-roll editor, playback, and export features can consume. Drums is the first instrument; the contract is the same for every instrument.

## ADDED Requirements

### Requirement: Generate a pattern from a text description
The system SHALL expose `POST /api/v1/patterns/generate` accepting a JSON body with `instrument` (string), `prompt` (string), `measures` (integer), and optional `tempo_bpm` (integer), `time_signature` (string), and `swing` (number). On success it SHALL respond `200` with a pattern document (see "Pattern document format") for the requested instrument.

#### Scenario: Successful generation with defaults
- **WHEN** a client posts `{"instrument": "drums", "prompt": "four on the floor house beat", "measures": 4}`
- **THEN** the response is `200` with a pattern whose `instrument` is `"drums"`, `measures` is 4, `time_signature` is `"4/4"`, and `tempo_bpm` is between 40 and 240 inclusive

#### Scenario: Explicit tempo is honored
- **WHEN** a client posts `{"instrument": "drums", "prompt": "trap hats", "measures": 8, "tempo_bpm": 140}`
- **THEN** the returned pattern's `tempo_bpm` is exactly 140

#### Scenario: Tempo inferred from the prompt when omitted
- **WHEN** a client omits `tempo_bpm`
- **THEN** the system selects a tempo appropriate to the description and returns it in `tempo_bpm`

### Requirement: Instrument selection
The `instrument` field SHALL name an instrument offered by the service (see "Instrument discovery"). A missing or unknown instrument SHALL be rejected with status `422` and error code `invalid_instrument`, and the AI provider SHALL NOT be invoked.

#### Scenario: Unknown instrument
- **WHEN** a client posts `{"instrument": "kazoo", "prompt": "anything", "measures": 4}`
- **THEN** the response is `422` with error code `invalid_instrument` and no AI provider call is made

### Requirement: Instrument discovery
The system SHALL expose `GET /api/v1/instruments` returning `200` with a list of available instruments, each with `id`, `name`, `midi_channel` (1–16), `sustained` (whether notes sound for their length or play as one-shots), and `rows` (each with `id`, `name`, and MIDI `midi_note`, in display order). In this change the list SHALL contain exactly the `drums` instrument.

#### Scenario: Drums is listed
- **WHEN** a client requests `GET /api/v1/instruments`
- **THEN** the response contains an instrument with `id` `"drums"`, `midi_channel` 10, `sustained` false, and its drum rows

### Requirement: Supported measure counts
The system SHALL accept exactly these values for `measures`: 4, 8, 12, 16, 32. The returned pattern SHALL span exactly the requested number of measures.

#### Scenario: Each allowed length produces a pattern of that length
- **WHEN** a client requests generation with `measures` set to any of 4, 8, 12, 16, or 32
- **THEN** the returned pattern's `measures` equals the requested value and every note ends at or before `measures × steps_per_measure`

#### Scenario: Unsupported length is rejected
- **WHEN** a client requests `measures: 10`
- **THEN** the response is `422` with error code `invalid_measures` and no AI provider call is made

#### Scenario: 64 measures is not supported
- **WHEN** a client requests `measures: 64`
- **THEN** the response is `422` with error code `invalid_measures` and no AI provider call is made

### Requirement: Input validation
The system SHALL reject requests where `prompt` is empty or only whitespace, `tempo_bpm` is outside 40–240, `time_signature` is not one of `"4/4"`, `"3/4"`, `"6/8"`, or `swing` is outside 0.0–0.75. Rejections SHALL use status `422` and SHALL NOT invoke the AI provider.

#### Scenario: Empty prompt
- **WHEN** a client posts `{"instrument": "drums", "prompt": "   ", "measures": 4}`
- **THEN** the response is `422` with error code `invalid_prompt`

#### Scenario: Tempo out of range
- **WHEN** a client posts `tempo_bpm: 300`
- **THEN** the response is `422` with error code `invalid_tempo`

### Requirement: Prompt token limit
The system SHALL limit the length of `prompt` by an estimated token count, where the estimate is `ceil(n / 4)` and `n` is the number of Unicode scalar values in `prompt` after trimming leading and trailing whitespace. The limit (`max_input_tokens`) SHALL come from service configuration, defaulting to 256. A prompt whose estimate exceeds the limit SHALL be rejected with status `422` and error code `prompt_too_long`, and the AI provider SHALL NOT be invoked.

#### Scenario: Prompt at the limit is accepted
- **WHEN** the limit is 256 and a client posts a prompt of 1024 characters (estimate 256)
- **THEN** the request is not rejected for length

#### Scenario: Prompt over the limit is rejected
- **WHEN** the limit is 256 and a client posts a prompt of 1025 characters (estimate 257)
- **THEN** the response is `422` with error code `prompt_too_long` and no AI provider call is made

#### Scenario: Multi-byte characters are counted as characters
- **WHEN** a client posts a prompt of 1024 single-code-point emoji (4096 UTF-8 bytes) with the limit at 256
- **THEN** the request is not rejected for length

### Requirement: Generation limits discovery
The system SHALL expose `GET /api/v1/patterns/limits` returning `200` with `{"max_input_tokens": <integer>, "measure_options": [4, 8, 12, 16, 32]}` reflecting the service's current configuration, so clients can enforce the same limits before submitting.

#### Scenario: Limits reflect configuration
- **WHEN** the service is configured with a max input token limit of 128 and a client requests the limits
- **THEN** the response contains `"max_input_tokens": 128` and `"measure_options": [4, 8, 12, 16, 32]`

### Requirement: Pattern document format
A pattern document SHALL contain: `version` (integer, currently 1), `instrument` (instrument id), `name` (short human-readable title), `tempo_bpm`, `time_signature`, `measures`, `steps_per_measure` (16 for 4/4, 12 for 3/4, 12 for 6/8 — i.e. sixteenth-note resolution), `swing`, `midi_channel` (1–16), `rows` (list of rows, each with `id`, `name`, and MIDI `midi_note`), and `notes` (list of `{row_id, step, length_steps, velocity}` where `step` is a zero-based absolute step index, `length_steps` is an integer ≥ 1, and `velocity` is 1–127). No note SHALL extend past the end of the pattern, and no two notes on the same row SHALL overlap (a note occupies steps `step` through `step + length_steps − 1`).

#### Scenario: Pattern is internally consistent
- **WHEN** any pattern is returned by the generate endpoint
- **THEN** every note references a row present in `rows`, every `velocity` is within 1–127, every `length_steps` is at least 1, every note ends within the pattern, and no two notes on the same row overlap

#### Scenario: Rows come from the instrument
- **WHEN** a pattern is generated for an instrument
- **THEN** its `rows` and `midi_channel` equal that instrument's rows and channel as listed by `GET /api/v1/instruments`

### Requirement: Musically varied long patterns
For patterns longer than 4 measures, the system SHALL NOT simply repeat one measure verbatim for the whole length; it SHALL include at least one variation or fill, placed at a phrase boundary (e.g. the last measure of every 4 or 8 measures). If the AI output contains no variation, the system SHALL insert one appropriate to the instrument.

#### Scenario: 16-measure pattern has variation
- **WHEN** a client requests a 16-measure pattern
- **THEN** at least one measure's notes differ from the pattern's first measure

### Requirement: Invalid AI output is never returned
The system SHALL validate and normalize every AI provider response before returning it. Out-of-range values SHALL be clamped or dropped, notes on unknown rows dropped, duplicate notes removed, overlapping notes on a row shortened so they no longer overlap, and notes running past the pattern end shortened to end at it. If the response cannot be parsed into a valid pattern after one retry, the system SHALL respond `502` with error code `generation_failed`.

#### Scenario: Provider returns malformed output twice
- **WHEN** the AI provider returns unparseable output on the first attempt and the retry
- **THEN** the response is `502` with error code `generation_failed` and a user-safe message

#### Scenario: Provider returns out-of-range velocity
- **WHEN** the AI provider returns a note with velocity 200
- **THEN** the returned pattern contains that note with velocity 127

#### Scenario: Provider returns overlapping notes
- **WHEN** the AI provider returns a note at step 0 with length 8 and another note on the same row at step 4
- **THEN** the returned pattern's first note has `length_steps` 4 and the second note is unchanged

### Requirement: Pluggable AI provider
The system SHALL select its AI provider from configuration at startup from: `claude` (Anthropic API, the default), `ollama` (a locally hosted Ollama server), `codex` (OpenAI's Codex CLI authenticated with the operator's ChatGPT account), and `mock`. A deterministic mock provider SHALL be available that, for the same request, always returns the same valid pattern without any network access. Every provider's output SHALL pass through the same validation, normalization, and retry rules, so the response contract is identical regardless of provider and instrument. At startup the service SHALL verify the selected provider is usable and SHALL fail with a message stating how to fix the problem if it is not.

#### Scenario: Mock provider is deterministic
- **WHEN** the service is configured with the mock provider and the same request is sent twice
- **THEN** both responses are identical and no outbound network request is made

#### Scenario: Claude provider without API key
- **WHEN** the service is configured with the Claude provider but no API key is set
- **THEN** the service fails to start with a clear message naming the missing setting

#### Scenario: Ollama server unreachable
- **WHEN** the service is configured with the Ollama provider and no Ollama server responds at the configured URL
- **THEN** the service fails to start with a message naming the URL and suggesting starting Ollama

#### Scenario: Ollama model not pulled
- **WHEN** the service is configured with the Ollama provider and the configured model is not available on the server
- **THEN** the service fails to start with a message including `ollama pull <model>`

#### Scenario: Ollama makes no third-party calls
- **WHEN** the service generates a pattern with the Ollama provider
- **THEN** the only outbound request is to the configured Ollama URL

#### Scenario: Codex CLI missing or signed out
- **WHEN** the service is configured with the Codex provider and the Codex CLI is not installed or is not signed in
- **THEN** the service fails to start with a message saying to install the CLI or run `codex login`

#### Scenario: Codex provider is local-only
- **WHEN** the service is configured with the Codex provider and its listen address is not a loopback address
- **THEN** the service fails to start with a message stating the Codex provider is for local testing only

#### Scenario: Codex provider warns at startup
- **WHEN** the service starts with the Codex provider on a loopback address
- **THEN** it logs a warning that the provider uses a personal ChatGPT subscription and is for local testing only

#### Scenario: Same contract across providers
- **WHEN** any provider returns a draft containing a note with velocity 200 or a duplicate note
- **THEN** the response is normalized identically (velocity 127, duplicate removed) regardless of which provider produced it

### Requirement: Generation time limit
The system SHALL abort a generation that exceeds the configured generation timeout (default 60 seconds) and respond `504` with error code `generation_timeout`.

#### Scenario: Provider hangs
- **WHEN** the timeout is the default and the AI provider does not respond within 60 seconds
- **THEN** the client receives `504` with error code `generation_timeout`
