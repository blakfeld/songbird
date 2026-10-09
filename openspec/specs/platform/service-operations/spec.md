# platform/service-operations Specification

## Purpose

Defines the operational behavior of the Songbird backend service shared by every tool: health checking, configuration, cross-origin access, and a consistent error format.

## Requirements

### Requirement: Health check
The service SHALL expose `GET /healthz` returning `200` with `{"status": "ok"}` whenever it is able to serve requests. It SHALL NOT call external services or the database, so that it reports only whether the process is alive. Whether the database is reachable is reported by `GET /readyz` (see `platform/database`).

#### Scenario: Healthy service
- **WHEN** a client requests `GET /healthz`
- **THEN** the response is `200` with body `{"status":"ok"}`

#### Scenario: Health does not touch the database
- **WHEN** the database is unreachable and a client requests `GET /healthz`
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
- allowed frontend origins;
- the database URL (`SONGBIRD_DATABASE_URL`, optional, default SQLite at `./data/songbird.db`, treated as a secret because it may contain a password);
- the maximum number of database connections (`SONGBIRD_DATABASE_MAX_CONNECTIONS`, default 10, allowed 1–100);
- whether the session cookie is `Secure` (`SONGBIRD_COOKIE_SECURE`, default `true`);
- the session idle lifetime in hours (`SONGBIRD_SESSION_IDLE_HOURS`, default 168, allowed 1–720);
- where to take the client address from for login throttling and other per-address limits (`SONGBIRD_TRUST_PROXY`): `false` for the connection's peer address (the default); `x-forwarded-for` for the first `X-Forwarded-For` entry, to be used only when the outermost proxy replaces any client-supplied `X-Forwarded-For`; or `fly-client-ip` for the `Fly-Client-IP` header, to be used only when the service is reachable solely through Fly.io's proxy. `true` SHALL be accepted as a synonym for `x-forwarded-for`, and any other value SHALL fail startup;
- the per-user limit on AI generation requests per minute (`SONGBIRD_AI_REQUESTS_PER_MINUTE`, default 10, allowed 1–600);
- the per-user limit on AI generation requests per UTC day (`SONGBIRD_AI_REQUESTS_PER_DAY`, default 200, allowed 1–100000).

Invalid or missing required configuration SHALL cause startup to fail with a message naming the offending setting. Startup SHALL also fail, naming both settings, when `SONGBIRD_COOKIE_SECURE` is `false` and any allowed frontend origin starts with `https://`, because a deployment served over https must not send its session cookie without `Secure`. When `SONGBIRD_TRUST_PROXY` is `false` and any allowed frontend origin starts with `https://`, the service SHALL log a warning at startup that login throttling will see the proxy's address for every client. Secrets SHALL NOT be written to logs.

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

#### Scenario: Insecure cookie with an https origin
- **WHEN** the service starts with `SONGBIRD_COOKIE_SECURE=false` and `SONGBIRD_CORS_ORIGINS=https://songbird.example`
- **THEN** the process exits non-zero and the error names `SONGBIRD_COOKIE_SECURE` and `SONGBIRD_CORS_ORIGINS`

#### Scenario: Untrusted proxy warned about
- **WHEN** the service starts with `SONGBIRD_TRUST_PROXY=false` and `SONGBIRD_CORS_ORIGINS=https://songbird.example`
- **THEN** it starts, and logs a warning naming `SONGBIRD_TRUST_PROXY`

#### Scenario: Unknown proxy trust value
- **WHEN** the service starts with `SONGBIRD_TRUST_PROXY=cloudflare`
- **THEN** the process exits non-zero and the error names `SONGBIRD_TRUST_PROXY`

#### Scenario: Legacy proxy trust value accepted
- **WHEN** the service starts with `SONGBIRD_TRUST_PROXY=true`
- **THEN** it starts, and takes the client address from the first `X-Forwarded-For` entry

#### Scenario: AI limit out of range
- **WHEN** the service starts with `SONGBIRD_AI_REQUESTS_PER_MINUTE=0`
- **THEN** the process exits non-zero and the error names `SONGBIRD_AI_REQUESTS_PER_MINUTE`

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

### Requirement: Per-user AI usage limits
Every endpoint that calls an AI provider SHALL be limited per signed-in user, by the configured requests per minute and requests per UTC day. That covers `POST /api/v1/patterns/generate`, `POST /api/v1/songs/tracks/generate`, `POST /api/v1/songs/chat`, and any lyrics or chords generation endpoint added later. A request over either limit SHALL be refused with `429`, code `too_many_requests`, and a `Retry-After` header, and SHALL NOT call the provider. A request SHALL count toward the limits whether or not the provider call then succeeds. The daily count SHALL survive a service restart. One user's usage SHALL NOT affect another's.

#### Scenario: Daily quota spent
- **WHEN** a user has made as many generation requests today as `SONGBIRD_AI_REQUESTS_PER_DAY` allows and posts to `/api/v1/songs/chat`
- **THEN** the response is `429` with code `too_many_requests` and a `Retry-After` header, and no provider is called

#### Scenario: Burst limited
- **WHEN** a user sends one more generation request within a minute than `SONGBIRD_AI_REQUESTS_PER_MINUTE` allows
- **THEN** that request gets `429` with a `Retry-After` header

#### Scenario: Quota survives a restart
- **WHEN** a user has spent the daily quota and the service restarts the same day
- **THEN** the user's next generation request still gets `429`

#### Scenario: Users limited separately
- **WHEN** user A has spent the daily quota and user B makes a generation request
- **THEN** user B's request is served

### Requirement: Security response headers
Every response from `/api/v1` SHALL carry `Cache-Control: no-store`, including error responses. Every page and asset served by the frontend SHALL carry:
- a `Content-Security-Policy` that allows scripts, styles, connections, and workers only from the site itself (plus inline scripts and styles and `blob:`/`data:` media where the app needs them), allows no plugins, and includes `frame-ancestors 'none'`;
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: same-origin`.

When the frontend runs in production mode, every page and asset SHALL also carry `Strict-Transport-Security: max-age=31536000`. In development mode it SHALL NOT, so that a browser never pins `http://localhost` to HTTPS.

These headers SHALL be set by the application, so that they apply in every way it is run, not only behind the production proxy.

#### Scenario: API responses not cached
- **WHEN** a signed-in client requests `GET /api/v1/projects`
- **THEN** the response has `Cache-Control: no-store`

#### Scenario: Pages cannot be framed
- **WHEN** a client requests `/studio`
- **THEN** the response has `X-Frame-Options: DENY` and a `Content-Security-Policy` containing `frame-ancestors 'none'`

#### Scenario: Headers present without the production proxy
- **WHEN** a client requests `/login` from the docker-compose stack
- **THEN** the response has `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`

#### Scenario: HSTS in production
- **WHEN** a client requests `/login` from the frontend running in production mode
- **THEN** the response has `Strict-Transport-Security: max-age=31536000`

#### Scenario: No HSTS in development
- **WHEN** a client requests `/login` from the frontend dev server
- **THEN** the response has no `Strict-Transport-Security` header

### Requirement: Request logging protects credentials
Request logs SHALL NOT contain request or response headers, passwords, or session tokens. After a request is authenticated, its log records SHALL carry the user's id and SHALL NOT carry the user's email. A failed login SHALL be logged with the client address and a one-way hash of the normalised email instead of the email itself.

#### Scenario: Authenticated request traced by user id
- **WHEN** a signed-in user requests `GET /api/v1/projects` while logs are captured
- **THEN** the request's log records include that user's id and do not include their email

#### Scenario: Failed login logged without the email
- **WHEN** a login for `ana@example.com` fails while logs are captured
- **THEN** a log line records the failure with the client address, and no log line contains `ana@example.com` or the submitted password

### Requirement: Deployment mode
The service SHALL read its deployment mode from `SONGBIRD_ENV`, which is `production` or `development`. When the variable is unset, the mode SHALL be `production`, so a deployment that forgets the setting fails closed rather than falling back to an operator-paid provider. Any other value SHALL fail startup with a message naming `SONGBIRD_ENV`.

In production mode the service SHALL refuse to start, with a message naming the offending setting, when any of the following is true:
- `SONGBIRD_AI_PROVIDER` is set to anything other than `user`;
- `ANTHROPIC_API_KEY` is set to a non-blank value, because no operator key may be present where users are served;
- `SONGBIRD_MASTER_KEYS` is unset, or fails to parse, or holds a key that is not exactly 32 bytes.

In development mode every provider mode is allowed. When the service runs in development mode, it SHALL log a warning at startup saying so.

#### Scenario: Unset means production
- **WHEN** the service starts with `SONGBIRD_ENV` unset, `SONGBIRD_AI_PROVIDER` unset, and a valid `SONGBIRD_MASTER_KEYS`
- **THEN** it starts in production mode, with per-user keys required

#### Scenario: Operator key present in production
- **WHEN** the service starts in production mode with `ANTHROPIC_API_KEY` set
- **THEN** the process exits non-zero, and the error names `ANTHROPIC_API_KEY` and says that production uses each user's own key

#### Scenario: No master key in production
- **WHEN** the service starts in production mode without `SONGBIRD_MASTER_KEYS`
- **THEN** the process exits non-zero and the error names `SONGBIRD_MASTER_KEYS`

#### Scenario: Unknown mode
- **WHEN** the service starts with `SONGBIRD_ENV=prod`
- **THEN** the process exits non-zero and the error names `SONGBIRD_ENV`

#### Scenario: Development warns
- **WHEN** the service starts with `SONGBIRD_ENV=development`
- **THEN** a startup log line at warning level states that the service is in development mode

### Requirement: AI key configuration
The service SHALL read these settings for per-user keys:
- `SONGBIRD_MASTER_KEYS`: a secret, comma-separated keyring of `<version>:<base64 32-byte key>` entries, where the first entry is used for new encryptions. It is required whenever the provider mode is `user` or `user-mock`.
- `SONGBIRD_AI_MODEL`: the model used for Anthropic.
- `SONGBIRD_OPENAI_MODEL`: the model used for OpenAI.

The master keys SHALL be treated as secrets and SHALL NOT be logged. In development mode with an operator provider and no master keys, the key-management endpoints SHALL respond `503` with error code `api_keys_unavailable`, and AI features SHALL keep using the operator provider.

#### Scenario: Malformed keyring
- **WHEN** the service starts with `SONGBIRD_MASTER_KEYS=v1:short`
- **THEN** the process exits non-zero and the error names `SONGBIRD_MASTER_KEYS` without printing its value

#### Scenario: Duplicate versions
- **WHEN** the keyring lists version `v1` twice
- **THEN** the process exits non-zero and the error names `SONGBIRD_MASTER_KEYS`

#### Scenario: Master key not logged
- **WHEN** the service starts with a valid keyring
- **THEN** no log line contains any of its keys

### Requirement: Graceful shutdown
When the backend or the production frontend server receives SIGTERM or SIGINT, it SHALL stop accepting new connections and SHALL let requests already in progress finish, including streaming chat responses, before exiting. If requests are still running 190 seconds after the signal, the process SHALL exit anyway. That limit is longer than the default chat stream deadline (2 x the generation timeout + 30 s) and shorter than the time a hosting platform is configured to wait before killing the process. A second signal received while draining SHALL NOT shorten the drain. The process SHALL exit with status 0 after a drain that ends because no requests remain.

#### Scenario: Stream finishes during shutdown
- **WHEN** a chat stream is in progress and the backend receives SIGTERM
- **THEN** the client receives the rest of the stream, including its final event, and the backend then exits with status 0

#### Scenario: New connections refused while draining
- **WHEN** the backend has received SIGTERM and is still finishing a request
- **THEN** a new connection to its listen address is refused

#### Scenario: Drain limit
- **WHEN** a request is still running 190 seconds after the backend receives SIGTERM
- **THEN** the backend exits without waiting for it

#### Scenario: Frontend proxy keeps the stream open
- **WHEN** a chat stream is passing through the production frontend server and that server receives SIGTERM
- **THEN** the client receives the rest of the stream before the frontend server exits
