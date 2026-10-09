# Spec Delta

## MODIFIED Requirements

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
- where to take the client address from for login throttling and other per-address limits (`SONGBIRD_TRUST_PROXY`): `false` for the connection's peer address (the default); `x-forwarded-for` for the last `X-Forwarded-For` entry, to be used only when the outermost proxy appends to or replaces any client-supplied `X-Forwarded-For` and no later hop appends its own entry; or `fly-client-ip` for the `Fly-Client-IP` header, to be used only when the service is reachable solely through Fly.io's proxy. `true` SHALL be accepted as a synonym for `x-forwarded-for`, and any other value SHALL fail startup;
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
- **THEN** it starts, and takes the client address from the last `X-Forwarded-For` entry

#### Scenario: AI limit out of range
- **WHEN** the service starts with `SONGBIRD_AI_REQUESTS_PER_MINUTE=0`
- **THEN** the process exits non-zero and the error names `SONGBIRD_AI_REQUESTS_PER_MINUTE`

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

## ADDED Requirements

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
