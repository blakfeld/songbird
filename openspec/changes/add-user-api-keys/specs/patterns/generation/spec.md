## MODIFIED Requirements

### Requirement: Pluggable AI provider
The system SHALL select its AI provider mode from configuration at startup. The modes are:
- `user`: each request uses the requesting user's own Anthropic or OpenAI key, as defined in `platform/user-api-keys`. This is the default and the only mode allowed in production.
- `claude`: the Anthropic API with the operator's key.
- `ollama`: a locally hosted Ollama server.
- `codex`: OpenAI's Codex CLI, authenticated with the operator's ChatGPT account.
- `mock`.
- `user-mock`: the per-user-key flow with the deterministic mock provider in place of real providers.

Every mode except `user` SHALL be available only in development mode (see `platform/service-operations`). In `user` mode, the system SHALL reach Anthropic through the Anthropic Messages API and OpenAI through the OpenAI API, each with schema-constrained output. OpenAI support SHALL NOT depend on the Codex CLI.

A deterministic mock provider SHALL be available that, for the same request, always returns the same valid pattern without any network access. Every provider's output SHALL pass through the same validation, normalization, and retry rules, so the response contract is identical regardless of provider, mode, and instrument. At startup the service SHALL verify that the selected operator provider is usable, and SHALL fail with a message stating how to fix the problem if it is not. In `user` mode no provider is contacted at startup, because there is no operator key to check.

#### Scenario: Mock provider is deterministic
- **WHEN** the service is configured with the mock provider and the same request is sent twice
- **THEN** both responses are identical and no outbound network request is made

#### Scenario: Claude provider without API key
- **WHEN** the service is in development mode, configured with the Claude provider, and no API key is set
- **THEN** the service fails to start with a clear message naming the missing setting

#### Scenario: Operator provider refused in production
- **WHEN** the service is in production mode and `SONGBIRD_AI_PROVIDER` is `claude`, `ollama`, `codex`, `mock`, or `user-mock`
- **THEN** the service fails to start with a message saying that production requires per-user keys and naming `SONGBIRD_AI_PROVIDER` and `SONGBIRD_ENV`

#### Scenario: Production defaults to per-user keys
- **WHEN** the service is in production mode and `SONGBIRD_AI_PROVIDER` is unset
- **THEN** the provider mode is `user`

#### Scenario: OpenAI with the user's key
- **WHEN** a user whose active provider is `openai` generates a pattern
- **THEN** the request is sent to the OpenAI API with that user's key and a strict JSON schema for the instrument's draft, and the response is normalized like every other provider's

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
