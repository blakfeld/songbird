# Spec Delta

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
