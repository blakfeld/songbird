## MODIFIED Requirements

### Requirement: Environment-based configuration
The service SHALL read its configuration from environment variables, optionally loaded from a `.env` file in development. The configuration SHALL include:
- listen address/port;
- AI provider selection, AI API key, and AI model identifier;
- Ollama server URL and model;
- Codex CLI path and optional model;
- generation timeout;
- maximum input tokens for generation prompts;
- maximum context tokens for song track generation (`SONGBIRD_MAX_CONTEXT_TOKENS`, default 4000, allowed 0–32000);
- allowed frontend origins;
- the database URL (`SONGBIRD_DATABASE_URL`, optional, default SQLite at `./data/songbird.db`, treated as a secret because it may contain a password);
- the maximum number of database connections (`SONGBIRD_DATABASE_MAX_CONNECTIONS`, default 10, allowed 1–100);
- whether the session cookie is `Secure` (`SONGBIRD_COOKIE_SECURE`, default `true`);
- the session idle lifetime in hours (`SONGBIRD_SESSION_IDLE_HOURS`, default 168, allowed 1–720);
- whether to take the client address from `X-Forwarded-For` for login throttling (`SONGBIRD_TRUST_PROXY`, default `false`).

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

#### Scenario: Pool size out of range
- **WHEN** the service starts with `SONGBIRD_DATABASE_MAX_CONNECTIONS=0`
- **THEN** the process exits non-zero and the error names `SONGBIRD_DATABASE_MAX_CONNECTIONS`

#### Scenario: Session lifetime out of range
- **WHEN** the service starts with `SONGBIRD_SESSION_IDLE_HOURS=1000`
- **THEN** the process exits non-zero and the error names `SONGBIRD_SESSION_IDLE_HOURS`

### Requirement: Request size limit
The service SHALL reject request bodies larger than 64 KiB with status `413`, except for routes under `/api/v1/songs/`, `/api/v1/lyrics/`, and `/api/v1/projects`, which SHALL accept bodies up to 2 MiB and reject larger bodies with status `413`. Every `413` response SHALL use the standard error shape with error code `payload_too_large`.

#### Scenario: Oversized body
- **WHEN** a client posts a 1 MiB body to `/api/v1/patterns/generate`
- **THEN** the response is `413`

#### Scenario: Large song accepted
- **WHEN** a client posts a valid 16-track, 128-measure song with a note on every step (about 1.9 MiB) to `/api/v1/songs/export/midi`
- **THEN** the request is not rejected for size

#### Scenario: Oversized song rejected
- **WHEN** a client posts a 3 MiB body to `/api/v1/songs/export/midi`
- **THEN** the response is `413` with error code `payload_too_large`

#### Scenario: Large project saved
- **WHEN** a signed-in client saves a valid song of about 1.9 MiB with `PUT /api/v1/projects/{id}`
- **THEN** the request is not rejected for size
