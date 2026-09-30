# platform/service-operations Specification

## Purpose

Defines the operational behavior of the Songbird backend service shared by every tool: health checking, configuration, cross-origin access, and a consistent error format.

## Requirements

### Requirement: Health check
The service SHALL expose `GET /healthz` returning `200` with `{"status": "ok"}` whenever it is able to serve requests. It SHALL NOT call external services.

#### Scenario: Healthy service
- **WHEN** a client requests `GET /healthz`
- **THEN** the response is `200` with body `{"status":"ok"}`

### Requirement: Environment-based configuration
The service SHALL read its configuration from environment variables (optionally loaded from a `.env` file in development), including listen address/port, AI provider selection, AI API key, AI model identifier, Ollama server URL and model, Codex CLI path and optional model, generation timeout, maximum input tokens for generation prompts, and allowed frontend origins. Invalid or missing required configuration SHALL cause startup to fail with a message naming the offending setting. Secrets SHALL NOT be written to logs.

#### Scenario: Missing required setting
- **WHEN** the service starts with an AI provider that requires an API key and the key is unset
- **THEN** the process exits non-zero and the error names the missing variable

#### Scenario: API key not logged
- **WHEN** the service starts with an API key configured
- **THEN** no log line contains the key value

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
The service SHALL reject request bodies larger than 64 KiB with status `413`.

#### Scenario: Oversized body
- **WHEN** a client posts a 1 MiB body
- **THEN** the response is `413`
