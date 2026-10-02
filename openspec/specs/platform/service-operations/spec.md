# platform/service-operations Specification

## Purpose

Defines the operational behavior of the Songbird backend service shared by every tool: health checking, configuration, cross-origin access, and a consistent error format.

## Requirements

### Requirement: Health check
The service SHALL expose `GET /healthz` returning `200` with `{"status": "ok"}` whenever it is able to serve requests. It SHALL NOT call external services.

#### Scenario: Healthy service
- **WHEN** a client requests `GET /healthz`
- **THEN** the response is `200` with body `{"status":"ok"}`

### Requirement: Concurrent generation limit
The service SHALL allow at most `SONGBIRD_MAX_CONCURRENT_GENERATIONS` LLM-backed requests to run at once, counted across `POST /api/v1/patterns/generate`, `POST /api/v1/songs/tracks/generate` and `POST /api/v1/songs/chat`. A request that arrives when the limit is reached SHALL be rejected immediately, not queued, with `503` and error code `generation_busy`. A slot SHALL be released when its request finishes, fails, times out or is abandoned. No other route SHALL be limited.

#### Scenario: Limit reached
- **WHEN** the limit is 1, one generation is running, and a client sends a second generation request to any of the three routes
- **THEN** the response is `503` with error code `generation_busy` and the provider is not called

#### Scenario: Slot released
- **WHEN** a running generation finishes or its client disconnects
- **THEN** the next generation request is accepted

#### Scenario: Cheap routes unaffected
- **WHEN** the limit is reached
- **THEN** `GET /healthz` and the limits endpoints still return `200`

#### Scenario: Concurrency limit out of range
- **WHEN** the service starts with `SONGBIRD_MAX_CONCURRENT_GENERATIONS=0`
- **THEN** the process exits non-zero and the error names `SONGBIRD_MAX_CONCURRENT_GENERATIONS`

### Requirement: Environment-based configuration
The service SHALL read its configuration from environment variables, optionally loaded from a `.env` file in development. The configuration SHALL include:
- listen address/port;
- AI provider selection, AI API key, and AI model identifier;
- Ollama server URL and model;
- Codex CLI path and optional model;
- generation timeout;
- maximum concurrent generations (`SONGBIRD_MAX_CONCURRENT_GENERATIONS`, default 4, allowed 1-64);
- maximum input tokens for generation prompts;
- maximum context tokens for song track generation (`SONGBIRD_MAX_CONTEXT_TOKENS`, default 4000, allowed 0–32000);
- allowed frontend origins.

Invalid or missing required configuration SHALL cause startup to fail with a message naming the offending setting. Secrets SHALL NOT be written to logs.

#### Scenario: Missing required setting
- **WHEN** the service starts with an AI provider that requires an API key and the key is unset
- **THEN** the process exits non-zero and the error names the missing variable

#### Scenario: API key not logged
- **WHEN** the service starts with an API key configured
- **THEN** no log line contains the key value

#### Scenario: Context budget out of range
- **WHEN** the service starts with `SONGBIRD_MAX_CONTEXT_TOKENS=50000`
- **THEN** the process exits non-zero and the error names `SONGBIRD_MAX_CONTEXT_TOKENS`

### Requirement: Cross-origin access for the frontend
The service SHALL permit browser requests from configured frontend origins and SHALL reject cross-origin requests from other origins.

#### Scenario: Allowed origin
- **WHEN** a browser at a configured origin calls the API
- **THEN** the response includes CORS headers permitting that origin

#### Scenario: Disallowed origin
- **WHEN** a browser at an unconfigured origin calls the API
- **THEN** the response does not include CORS headers permitting that origin

### Requirement: Consistent error responses
All API error responses SHALL be JSON of the form `{"error": {"code": "<machine_code>", "message": "<human readable>"}}` with an appropriate HTTP status. Error messages SHALL NOT expose internal details such as stack traces, upstream API keys, or raw provider responses.

#### Scenario: Unknown route
- **WHEN** a client requests a path that does not exist under `/api`
- **THEN** the response is `404` with error code `not_found` in the standard error shape

#### Scenario: Malformed JSON body
- **WHEN** a client posts invalid JSON to an API endpoint
- **THEN** the response is `400` with error code `invalid_json` in the standard error shape

### Requirement: Request size limit
The service SHALL reject request bodies larger than 64 KiB with status `413`, except for routes under `/api/v1/songs/` and `/api/v1/lyrics/`, which SHALL accept bodies up to 2 MiB and reject larger bodies with status `413`. Every `413` response SHALL use the standard error shape with error code `payload_too_large`.

#### Scenario: Oversized body
- **WHEN** a client posts a 1 MiB body to `/api/v1/patterns/generate`
- **THEN** the response is `413`

#### Scenario: Large song accepted
- **WHEN** a client posts a valid 16-track, 128-measure song with a note on every step (about 1.9 MiB) to `/api/v1/songs/export/midi`
- **THEN** the request is not rejected for size

#### Scenario: Oversized song rejected
- **WHEN** a client posts a 3 MiB body to `/api/v1/songs/export/midi`
- **THEN** the response is `413` with error code `payload_too_large`
