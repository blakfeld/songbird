CREATE TABLE share_links (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('live', 'snapshot')),
    label TEXT NOT NULL DEFAULT '',
    snapshot TEXT,
    snapshot_bytes INTEGER NOT NULL DEFAULT 0,
    allow_comments INTEGER NOT NULL,
    allow_downloads INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX share_links_project ON share_links (project_id, created_at);
CREATE INDEX share_links_owner ON share_links (owner_id);

CREATE TABLE share_comments (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES share_links (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    at_step INTEGER NOT NULL,
    section_id TEXT,
    section_name TEXT,
    project_revision INTEGER,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE INDEX share_comments_project ON share_comments (project_id, at_step);
CREATE INDEX share_comments_share ON share_comments (share_id, created_at);
