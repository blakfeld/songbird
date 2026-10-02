## ADDED Requirements

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
