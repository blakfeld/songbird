CREATE TABLE user_api_keys (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
    key_version TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    last4 TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider)
);

CREATE INDEX user_api_keys_key_version ON user_api_keys (key_version);

CREATE TABLE user_ai_settings (
    user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    active_provider TEXT CHECK (active_provider IN ('anthropic', 'openai')),
    updated_at BIGINT NOT NULL
);
