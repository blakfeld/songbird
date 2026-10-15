ALTER TABLE share_links ADD COLUMN allow_remix INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX users_username ON users (username);

ALTER TABLE share_comments ADD COLUMN author_id TEXT REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX share_comments_author ON share_comments (author_id);
