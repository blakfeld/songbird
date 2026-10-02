CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    disabled BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    time_signature TEXT NOT NULL,
    track_count INTEGER NOT NULL,
    song TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX projects_owner_updated ON projects (owner_id, updated_at);

CREATE TABLE ai_usage (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    day INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
);
