## MODIFIED Requirements

### Requirement: Health check
The service SHALL expose `GET /healthz` returning `200` with `{"status": "ok"}` whenever it is able to serve requests. It SHALL NOT call external services or the database, so that it reports only whether the process is alive. Whether the database is reachable is reported by `GET /readyz` (see `platform/database`).

#### Scenario: Healthy service
- **WHEN** a client requests `GET /healthz`
- **THEN** the response is `200` with body `{"status":"ok"}`

#### Scenario: Health does not touch the database
- **WHEN** the database is unreachable and a client requests `GET /healthz`
- **THEN** the response is `200` with body `{"status":"ok"}`

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
- the maximum number of database connections (`SONGBIRD_DATABASE_MAX_CONNECTIONS`, default 10, allowed 1–100).

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
