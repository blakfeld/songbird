# Spec Delta

## ADDED Requirements

### Requirement: Alternative takes
`POST /api/v1/songs/tracks/generate` SHALL accept an optional `take` field of the form `{"index", "count"}`. It marks the request as one of `count` alternative takes of the same part, and `index` (1-based) says which take this is.

**Validation.** `count` SHALL be an integer from 2 to 6, and `index` SHALL be an integer from 1 to `count`. Any other value, or a `take` that is not an object with exactly those two fields, SHALL be rejected with `422` and error code `invalid_take`, before any provider call.

**Provider instruction.** When `take` is present, the system SHALL tell the provider that the result is take `index` of `count`, and that it should differ clearly from other takes of the same prompt in rhythm or melodic shape while still following the prompt and the song context.

**Unchanged behavior.**
- When `take` is absent, the request and the context sent to the provider SHALL be exactly as before this requirement.
- The response shape, the range rules, and every other validation rule SHALL be the same with or without `take`.
- Each request with `take` SHALL be metered as one AI request, the same as a request without it.

**Mock provider.** With the mock provider, two requests that differ only in `take.index` SHALL return different notes, and the same request with the same `take` SHALL return the same notes.

#### Scenario: Takes differ under the mock
- **WHEN** the service uses the mock provider and a client sends the same Bass generation request with `take` `{1, 4}` and then with `take` `{2, 4}`
- **THEN** both responses are `200`, and their `notes` differ

#### Scenario: Same take is repeatable under the mock
- **WHEN** the service uses the mock provider and the same request with `take` `{3, 4}` is sent twice
- **THEN** both responses contain identical notes

#### Scenario: Invalid take refused
- **WHEN** a client sends `take` `{"index": 5, "count": 4}` or `{"index": 1, "count": 9}`
- **THEN** the response is `422` with error code `invalid_take`, and no AI provider call is made

#### Scenario: No take, unchanged request
- **WHEN** a track generation request without `take` is sent
- **THEN** the context sent to the provider contains no take instruction, and the result equals what the same request produced before this requirement existed
