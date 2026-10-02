# Spec Delta

## Purpose

Lets each signed-in user run Songbird's AI features on their own Anthropic or OpenAI API key, so the operator never pays for other people's usage, while keeping those keys secret: encrypted at rest, never returned to a browser, and never written to logs.

## ADDED Requirements

### Requirement: Per-user provider keys
A signed-in user SHALL be able to store at most one API key per supported provider. The supported providers are `anthropic` and `openai`. A user MAY store a key for one provider or for both. Keys SHALL belong to exactly one user. No user SHALL be able to read, use, replace, or remove another user's key. Every key-management endpoint SHALL require a valid session and SHALL return `401 unauthenticated` without one.

#### Scenario: Store one key
- **WHEN** a signed-in user with no keys saves a valid Anthropic key
- **THEN** their key summary lists one `anthropic` key and no `openai` key

#### Scenario: Store both keys
- **WHEN** a signed-in user saves a valid Anthropic key and then a valid OpenAI key
- **THEN** their key summary lists both providers

#### Scenario: Keys are per user
- **WHEN** user A has saved an Anthropic key and user B, who has none, requests their own key summary
- **THEN** user B's summary lists no keys

#### Scenario: Signed out
- **WHEN** a client without a session calls any key-management endpoint
- **THEN** the response is `401` with error code `unauthenticated`

### Requirement: Key summary never contains the key
The system SHALL expose `GET /api/v1/account/ai-keys`, which returns `200` with this JSON:
- `keys_required`: whether AI features need the user's own key on this server;
- `active_provider`: `"anthropic"`, `"openai"`, or `null`;
- `keys`: an array with one entry per stored key, each holding `provider`, `last4` (the last 4 characters of the key), and `updated_at`.

The only information about a key that any API response contains SHALL be its provider, its last 4 characters, and its timestamps. No API response, including the responses to saving a key, SHALL contain any other part of a stored or submitted key. Key-management responses SHALL carry `Cache-Control: no-store`.

#### Scenario: Summary is masked
- **WHEN** a user who saved the Anthropic key `sk-ant-api03-EXAMPLEabcd` requests their key summary
- **THEN** the `anthropic` entry has `last4` `abcd`, and the body does not contain `sk-ant-api03-EXAMPLE`

#### Scenario: Save response is masked
- **WHEN** a user saves a key
- **THEN** the response body does not contain the submitted key, and the response has `Cache-Control: no-store`

### Requirement: Saving a key
The system SHALL expose `PUT /api/v1/account/ai-keys/{provider}` with body `{"key": "<string>"}`. Saving a key for a provider that already has one SHALL replace it. Before storing a key, the system SHALL apply these checks in order. A key that fails any check SHALL NOT be stored, and any previously stored key for that provider SHALL be kept:
1. **Format.** After trimming whitespace, the key SHALL be 20 to 256 characters long and contain only ASCII letters, digits, `-`, and `_`. An Anthropic key SHALL start with `sk-ant-`. An OpenAI key SHALL start with `sk-` and SHALL NOT start with `sk-ant-`. A key that fails this check SHALL get `422` with error code `invalid_api_key_format`.
2. **Live check.** The key SHALL be checked against its provider with a request that does not generate content, under a 10-second timeout. If the provider rejects the key as invalid or unauthorized, the response SHALL be `422` with error code `api_key_rejected`. If the provider cannot be reached in time or returns a server error, the response SHALL be `502` with error code `provider_unreachable`.

A successful save SHALL respond `200` with the updated key summary. An unknown `{provider}` SHALL get `404 not_found`. No error response SHALL include any text from the provider's response.

#### Scenario: Valid key saved
- **WHEN** a user saves a well-formed Anthropic key that the provider accepts
- **THEN** the response is `200` and the summary lists the `anthropic` key with its last 4 characters

#### Scenario: Malformed key
- **WHEN** a user saves `hello` as their OpenAI key
- **THEN** the response is `422` with error code `invalid_api_key_format`, and no provider request is made

#### Scenario: Anthropic key saved as OpenAI
- **WHEN** a user saves a key starting with `sk-ant-` under `openai`
- **THEN** the response is `422` with error code `invalid_api_key_format`

#### Scenario: Provider rejects the key
- **WHEN** a user saves a well-formed key and the provider answers the check with an authentication error
- **THEN** the response is `422` with error code `api_key_rejected`, and nothing is stored

#### Scenario: Provider unreachable
- **WHEN** the provider does not answer the check within 10 seconds
- **THEN** the response is `502` with error code `provider_unreachable`, and nothing is stored

#### Scenario: Replacement keeps the old key on failure
- **WHEN** a user with a stored Anthropic key ending `abcd` submits a replacement that the provider rejects
- **THEN** the summary still lists the Anthropic key ending `abcd`

#### Scenario: Provider error body is not echoed
- **WHEN** the provider answers the check with an error body containing the submitted key
- **THEN** the API response does not contain any part of that body

### Requirement: Key save throttling
The system SHALL limit each user to 10 key-save attempts per hour, counting attempts that fail the format check or the live check. Further attempts in that window SHALL get `429` with error code `too_many_requests` and a `Retry-After` header, without contacting the provider. This limit prevents the save endpoint from being used to test stolen keys.

#### Scenario: Too many attempts
- **WHEN** a user makes an 11th key-save attempt within an hour
- **THEN** the response is `429` with error code `too_many_requests`, and no provider request is made

### Requirement: Removing a key
The system SHALL expose `DELETE /api/v1/account/ai-keys/{provider}`, which permanently deletes the user's key for that provider and responds `200` with the updated summary. Removing a key that does not exist SHALL also respond `200`, so the request is idempotent.

#### Scenario: Remove a key
- **WHEN** a user removes their OpenAI key
- **THEN** the summary no longer lists `openai`, and later AI requests cannot use that key

### Requirement: Active provider
Each user's AI requests SHALL use exactly one provider, the active provider:
- Saving a key when the user has no active provider SHALL make that key's provider active.
- When the user has keys for both providers, `PUT /api/v1/account/ai-provider` with body `{"provider": "anthropic" | "openai"}` SHALL set the active provider and respond `200` with the summary.
- Choosing a provider for which the user has no key SHALL get `409 api_key_required`.
- Removing the active provider's key SHALL make the other provider active if the user has a key for it. Otherwise there SHALL be no active provider.

The model used for each provider SHALL be set by server configuration, not by the user.

#### Scenario: First key becomes active
- **WHEN** a user with no keys saves an OpenAI key
- **THEN** `active_provider` is `openai`

#### Scenario: Switch provider
- **WHEN** a user with both keys and `active_provider` `anthropic` sets the provider to `openai`
- **THEN** `active_provider` is `openai`, and their next AI request is sent to OpenAI

#### Scenario: Removing the active key falls back
- **WHEN** a user with both keys removes the key of the active provider `anthropic`
- **THEN** `active_provider` is `openai`

#### Scenario: Choosing a provider without a key
- **WHEN** a user with only an Anthropic key sets the provider to `openai`
- **THEN** the response is `409` with error code `api_key_required`

### Requirement: AI requests use the caller's key
When `keys_required` is true, every endpoint that calls an AI provider SHALL call it only with the requesting user's key for their active provider, and SHALL NOT use any operator key. These endpoints are `/api/v1/patterns/generate`, `/api/v1/songs/tracks/generate`, and `/api/v1/songs/chat`, plus `/api/v1/lyrics/assist` and `/api/v1/songs/chords/generate` when those exist. Every provider call that one request makes, such as the two calls made by song chat, SHALL use the same key. When the user has no active provider, the endpoint SHALL respond `409` with error code `api_key_required` and SHALL NOT call any provider. The per-user AI rate limit from `platform/accounts` SHALL still apply, because a stolen session could otherwise spend the victim's key.

#### Scenario: Generation uses the user's key
- **WHEN** a user whose active provider is `anthropic` generates a pattern
- **THEN** the outbound provider request carries that user's Anthropic key and no other

#### Scenario: Two users, two keys
- **WHEN** user A and user B, each with their own OpenAI key, generate a track at the same time
- **THEN** each provider request carries the key of the user who made it

#### Scenario: No key
- **WHEN** a signed-in user with no keys posts a valid request to `/api/v1/songs/chat`
- **THEN** the response is `409` with error code `api_key_required`, and no provider request is made

#### Scenario: Rate limit still applies
- **WHEN** a user with a valid key exceeds the per-user AI rate limit
- **THEN** further AI requests are refused with `429 too_many_requests` before any provider request is made

### Requirement: Provider errors with the user's key
When a provider call made with the user's key fails, the system SHALL classify the failure from the provider's status and machine-readable error type only, and SHALL map it as follows:
- The provider rejects the key as invalid, revoked, or unauthorized: `409 api_key_invalid`.
- The account behind the key has no credit or quota left: `409 api_key_quota_exhausted`.
- The provider rate-limits the key: `429 api_key_rate_limited`. If the provider gave a retry delay, the response SHALL include it as `Retry-After`.
- Any other provider failure keeps the existing generation errors (`502 generation_failed`, `504 generation_timeout`).

These failures SHALL NOT be retried. Error messages SHALL name the provider and say what the user can do, such as replacing the key or checking billing, and SHALL NOT contain provider response text. A key the provider rejects SHALL remain stored until the user replaces or removes it.

#### Scenario: Revoked key
- **WHEN** a user's stored Anthropic key has been revoked and they generate a pattern
- **THEN** the response is `409` with error code `api_key_invalid`, and its message says to replace the Anthropic key

#### Scenario: Quota exhausted
- **WHEN** OpenAI reports that the user's key has no quota left
- **THEN** the response is `409` with error code `api_key_quota_exhausted`

#### Scenario: Rate limited with retry delay
- **WHEN** the provider answers `429` with `retry-after: 20`
- **THEN** the response is `429` with error code `api_key_rate_limited` and `Retry-After: 20`

#### Scenario: Not retried
- **WHEN** the provider rejects the key on the first attempt
- **THEN** exactly one provider request is made

### Requirement: Keys encrypted at rest
Every stored key SHALL be encrypted with authenticated encryption under a server master key, with a fresh random nonce for each encryption. The ciphertext SHALL be bound to its user and provider, so that ciphertext copied into another user's or another provider's row fails to decrypt instead of being used. Each stored key SHALL record which master key version encrypted it. The plaintext key SHALL NOT be stored anywhere: not in the database, on disk, or in any cache. The plaintext SHALL exist in server memory only while a key is checked or a provider request is made.

#### Scenario: Database contents
- **WHEN** a user saves a key and the database is inspected
- **THEN** no column contains the key or any part of it except the stored last 4 characters

#### Scenario: Swapped ciphertext
- **WHEN** user A's stored ciphertext is copied into user B's row and user B generates a pattern
- **THEN** decryption fails, no provider request is made, and the response is `409 api_key_invalid`, with a server log entry that names neither key

#### Scenario: Same key saved twice
- **WHEN** the same key is saved twice
- **THEN** the two stored ciphertexts differ

### Requirement: Master key rotation
The server SHALL accept an ordered keyring of master keys, each with a version identifier. It SHALL encrypt with the first key and decrypt with whichever key matches a row's version. An operator command SHALL re-encrypt every stored key under the current master key and report how many keys it rewrote. On startup, if any stored key uses a master key version that is missing from the keyring, the server SHALL refuse to start and SHALL name the missing versions.

#### Scenario: Rotate
- **WHEN** the operator adds a new master key at the front of the keyring and runs the rotation command
- **THEN** every stored key now records the new version, and every user's key still works

#### Scenario: Old key removed too early
- **WHEN** some stored keys still use version `v1` and the operator starts the server without `v1` in the keyring
- **THEN** startup fails with a message naming `v1` and the rotation command

### Requirement: Keys are deleted with their user
Deleting a user SHALL delete their stored keys and active-provider choice in the same operation. Disabling a user SHALL keep their keys, but the keys SHALL NOT be usable while the user cannot sign in. Database backups made before the deletion MAY still contain the ciphertext until they expire. That ciphertext SHALL be unreadable without the master key.

#### Scenario: User deleted
- **WHEN** the operator deletes a user who has stored keys
- **THEN** no row for that user's keys remains

### Requirement: Keys never leak
A stored or submitted key SHALL NOT appear in any log line, trace span or field, error message, panic message, debug output, API response, or response header, on success or on failure. This includes the server's validation errors for a key-save request body.

#### Scenario: Logs on a failed save
- **WHEN** a user submits a key that the provider rejects, with logging at the most verbose level
- **THEN** no captured log output contains any 8-character substring of the key

#### Scenario: Logs on generation
- **WHEN** a user generates a pattern with their key, both when the provider succeeds and when it returns an error
- **THEN** no captured log output or response contains the key

#### Scenario: Malformed body
- **WHEN** a client posts `{"key": 12345678901234567890}` or `{"key": "sk-...", "extra": true}` to save a key
- **THEN** the error response contains no part of the submitted body

### Requirement: Deterministic mock key provider
For tests and e2e runs, a development-only `user-mock` provider SHALL behave like per-user-key mode without any network access. It SHALL decide the outcome from a well-formed key's ending, as follows:

| Key ending | Outcome |
|---|---|
| `-rejected` | The save fails with `api_key_rejected`. |
| `-unreachable` | The save fails with `provider_unreachable`. |
| `-revoked` | The key saves, but AI requests fail with `api_key_invalid`. |
| `-quota` | The key saves, but AI requests fail with `api_key_quota_exhausted`. |
| `-ratelimited` | The key saves, but AI requests fail with `api_key_rate_limited` and `Retry-After: 5`. |
| Anything else | The key saves, and AI requests return the mock provider's deterministic output. |

#### Scenario: Mock key works offline
- **WHEN** the server runs with `user-mock` and a user saves `sk-ant-test-0000000000ok` and generates a pattern
- **THEN** the pattern equals the mock provider's output, and no outbound network request is made

#### Scenario: Mock revoked key
- **WHEN** the server runs with `user-mock` and a user whose key ends with `-revoked` generates a pattern
- **THEN** the response is `409 api_key_invalid`

### Requirement: AI keys settings page
The app SHALL provide an AI keys settings page that is reachable from the signed-in user menu. For each provider, the page SHALL show either "Not set" or that a key is set together with its last 4 characters. It SHALL offer Set when no key exists, and Replace and Remove when one does. Remove SHALL ask for confirmation. Key entry SHALL use a masked input with autocomplete and spellcheck off. After a submit, whether it succeeds or fails, the entered value SHALL be cleared from the page. The value SHALL NOT be written to browser storage. When the user has keys for both providers, the page SHALL let them choose the active provider. When `keys_required` is false, the page SHALL say that this server uses a shared development provider.

#### Scenario: Set a key
- **WHEN** a user enters a valid key for Anthropic and saves
- **THEN** the Anthropic row shows that a key is set with its last 4 characters, and the input is empty

#### Scenario: Save error shown
- **WHEN** saving fails with `api_key_rejected`
- **THEN** the page shows a message saying that the provider rejected the key, and the input is empty

#### Scenario: Key not persisted in the browser
- **WHEN** a user saves a key
- **THEN** neither localStorage nor sessionStorage contains it

### Requirement: AI actions need a key in the UI
When `keys_required` is true and the user has no active provider, every AI action SHALL be disabled, and each SHALL show a notice next to it saying that an Anthropic or OpenAI key is needed, with a link to the AI keys settings page. The AI actions are pattern Generate, track generation, song chat send, and later lyric assist and chord generation. No AI action SHALL fail without visible feedback. When an AI request returns `api_key_required`, `api_key_invalid`, `api_key_quota_exhausted`, or `api_key_rate_limited`, the app SHALL show a user-facing message for that code. For every code except `api_key_rate_limited`, the message SHALL include a link to the settings page. The app SHALL then reload the key summary.

#### Scenario: No key disables Generate
- **WHEN** a user with no keys opens a pattern editor on a server where keys are required
- **THEN** Generate is disabled, and a notice links to the AI keys settings page

#### Scenario: Key removed in another tab
- **WHEN** a user's key is removed elsewhere and they then send a song chat message
- **THEN** the chat shows a message that a key is needed, with a link to settings, and the send action becomes disabled

#### Scenario: Revoked key during generation
- **WHEN** track generation returns `api_key_invalid`
- **THEN** the dialog shows a message saying that the provider rejected the key, with a link to replace it

#### Scenario: Development server with a shared provider
- **WHEN** `keys_required` is false
- **THEN** AI actions are enabled whether or not the user has keys
