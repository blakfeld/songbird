//! Every owner-facing query is scoped by `owner_id`, including the lookups
//! that follow a failed conditional write, so another user's ids behave
//! exactly like ids that never existed.

use music::Song;
use serde_json::Value;
use sqlx::any::AnyRow;
use sqlx::Row;

use crate::clock::now_ms;
use crate::db::Db;
use crate::project_store::{count_and_bytes, lock_owner, MAX_STORED_BYTES_PER_USER};
use crate::token::{hash_token, is_well_formed};
use crate::users::decode_bool;

pub const MAX_ACTIVE_SHARES_PER_PROJECT: i64 = 20;
pub const MAX_COMMENTS_PER_SHARE: i64 = 1_000;
pub const TOKEN_PREFIX_CHARS: usize = 6;

/// Song fields the listener never receives. Everything else is served, so a
/// field added to `Song` is public until someone classifies it here; the test
/// below fails the build until they do.
const PRIVATE_SONG_FIELDS: [&str; 2] = ["chat", "lyric_chat"];
const PRIVATE_SECTION_FIELDS: [&str; 1] = ["notes"];

#[derive(Debug, thiserror::Error)]
pub enum ShareError {
    #[error("no such project, share link, or comment")]
    NotFound,
    #[error("share link limit")]
    ShareLimit,
    #[error("project storage limit")]
    ProjectLimit,
    #[error("comment limit")]
    CommentLimit,
    #[error("a stored song could not be projected: {0}")]
    Projection(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareMode {
    Live,
    Snapshot,
}

impl ShareMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Snapshot => "snapshot",
        }
    }

    fn parse(value: &str) -> Result<Self, sqlx::Error> {
        match value {
            "live" => Ok(Self::Live),
            "snapshot" => Ok(Self::Snapshot),
            other => Err(sqlx::Error::Decode(
                format!("unknown share mode {other:?}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareStatus {
    Active,
    Expired,
    Revoked,
}

impl ShareStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewShare {
    pub mode: ShareMode,
    pub label: String,
    pub expires_at: Option<i64>,
    pub allow_comments: bool,
    pub allow_downloads: bool,
}

#[derive(Debug, Clone)]
pub struct ShareEdit {
    pub label: String,
    pub expires_at: Option<i64>,
    pub allow_comments: bool,
    pub allow_downloads: bool,
}

/// What the owner sees. The token and its hash are deliberately not columns here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareSummary {
    pub id: String,
    pub token_prefix: String,
    pub mode: ShareMode,
    pub label: String,
    pub allow_comments: bool,
    pub allow_downloads: bool,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
    pub unresolved_comments: i64,
}

impl ShareSummary {
    pub fn status(&self, now: i64) -> ShareStatus {
        if self.revoked_at.is_some() {
            ShareStatus::Revoked
        } else if self.expires_at.is_some_and(|at| at <= now) {
            ShareStatus::Expired
        } else {
            ShareStatus::Active
        }
    }
}

/// What a listener's request resolves to. No owner or project identifiers
/// beyond what the handler needs to anchor a comment.
#[derive(Debug, Clone)]
pub struct ActiveShare {
    pub id: String,
    pub project_id: String,
    pub mode: ShareMode,
    pub allow_comments: bool,
    pub allow_downloads: bool,
    pub expires_at: Option<i64>,
    pub song: Value,
    /// Set only for live links, so a comment can say which version it heard.
    pub project_revision: Option<i64>,
    pub shared_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerComment {
    pub id: String,
    pub share_id: String,
    pub share_label: String,
    pub token_prefix: String,
    pub name: String,
    pub body: String,
    pub at_step: i64,
    pub section_id: Option<String>,
    pub section_name: Option<String>,
    pub project_revision: Option<i64>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewComment {
    pub name: String,
    pub body: String,
    pub at_step: i64,
    pub section_id: Option<String>,
    pub section_name: Option<String>,
    pub project_revision: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredComment {
    pub id: String,
    pub created_at: i64,
}

/// serde_json messages quote the offending value, which here is the owner's song text, so
/// only the category and position are kept for logs.
pub fn json_error_kind(error: &serde_json::Error) -> String {
    format!(
        "{:?} at line {} column {}",
        error.classify(),
        error.line(),
        error.column()
    )
}

/// Works on the JSON value rather than the typed song: re-serialising would drop
/// fields this build does not know, the same rule the project routes follow.
/// Parsing into `Song` first means only a well-formed song is ever served.
pub fn project_song(song_json: &str) -> Result<Value, ShareError> {
    serde_json::from_str::<Song>(song_json)
        .map_err(|e| ShareError::Projection(json_error_kind(&e)))?;
    let mut value: Value =
        serde_json::from_str(song_json).map_err(|e| ShareError::Projection(json_error_kind(&e)))?;
    let Some(song) = value.as_object_mut() else {
        return Err(ShareError::Projection("song is not an object".into()));
    };
    for field in PRIVATE_SONG_FIELDS {
        song.remove(field);
    }
    if let Some(Value::Array(sections)) = song.get_mut("sections") {
        for section in sections.iter_mut().filter_map(Value::as_object_mut) {
            for field in PRIVATE_SECTION_FIELDS {
                section.remove(field);
            }
        }
    }
    Ok(value)
}

/// The projection removes section notes, which `Song` requires, so they are
/// restored as empty text for the typed view only; the served JSON stays without them.
pub fn parse_projected(projected: &Value) -> Result<Song, serde_json::Error> {
    let mut value = projected.clone();
    if let Some(Value::Array(sections)) = value.get_mut("sections") {
        for section in sections.iter_mut().filter_map(Value::as_object_mut) {
            for field in PRIVATE_SECTION_FIELDS {
                section
                    .entry(field)
                    .or_insert_with(|| Value::String(String::new()));
            }
        }
    }
    serde_json::from_value(value)
}

const SUMMARY_COLUMNS: &str = "s.id, s.token_prefix, s.mode, s.label, s.allow_comments, \
     s.allow_downloads, s.expires_at, s.created_at, s.revoked_at, \
     (SELECT COUNT(*) FROM share_comments c WHERE c.share_id = s.id AND c.resolved_at IS NULL) \
     AS unresolved";

fn summary_from_row(row: &AnyRow) -> Result<ShareSummary, sqlx::Error> {
    Ok(ShareSummary {
        id: row.try_get("id")?,
        token_prefix: row.try_get("token_prefix")?,
        mode: ShareMode::parse(&row.try_get::<String, _>("mode")?)?,
        label: row.try_get("label")?,
        allow_comments: decode_bool(row, "allow_comments")?,
        allow_downloads: decode_bool(row, "allow_downloads")?,
        expires_at: row.try_get("expires_at")?,
        created_at: row.try_get("created_at")?,
        revoked_at: row.try_get("revoked_at")?,
        unresolved_comments: row.try_get("unresolved")?,
    })
}

async fn require_owned_project(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    owner_id: &str,
    project_id: &str,
) -> Result<AnyRow, ShareError> {
    sqlx::query("SELECT song, revision FROM projects WHERE id = $1 AND owner_id = $2")
        .bind(project_id)
        .bind(owner_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(ShareError::NotFound)
}

async fn project_is_owned(db: &Db, owner_id: &str, project_id: &str) -> Result<(), ShareError> {
    sqlx::query("SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2")
        .bind(project_id)
        .bind(owner_id)
        .fetch_optional(db.pool())
        .await?
        .map(|_| ())
        .ok_or(ShareError::NotFound)
}

/// The snapshot is taken from the project row read inside the transaction, so
/// it is exactly the song as saved at this instant even while the owner edits.
pub async fn create(
    db: &Db,
    owner_id: &str,
    project_id: &str,
    new: &NewShare,
    token: &str,
) -> Result<ShareSummary, ShareError> {
    let now = now_ms();
    let id = uuid::Uuid::now_v7().to_string();
    let mut tx = db.pool().begin().await?;
    lock_owner(&mut tx, owner_id).await?;
    let project = require_owned_project(&mut tx, owner_id, project_id).await?;

    let active: i64 = sqlx::query(
        "SELECT COUNT(*) AS n FROM share_links WHERE project_id = $1 AND owner_id = $2 \
         AND revoked_at IS NULL",
    )
    .bind(project_id)
    .bind(owner_id)
    .fetch_one(&mut *tx)
    .await?
    .try_get("n")?;
    if active >= MAX_ACTIVE_SHARES_PER_PROJECT {
        return Err(ShareError::ShareLimit);
    }

    let snapshot = match new.mode {
        ShareMode::Live => None,
        ShareMode::Snapshot => {
            let song: String = project.try_get("song")?;
            Some(project_song(&song)?.to_string())
        }
    };
    let snapshot_bytes = snapshot
        .as_ref()
        .map_or(0, |s| i64::try_from(s.len()).unwrap_or(i64::MAX));
    if snapshot_bytes > 0 {
        let (_, bytes) = count_and_bytes(&mut tx, owner_id).await?;
        if bytes.saturating_add(snapshot_bytes) > MAX_STORED_BYTES_PER_USER {
            return Err(ShareError::ProjectLimit);
        }
    }

    let prefix: String = token.chars().take(TOKEN_PREFIX_CHARS).collect();
    sqlx::query(
        "INSERT INTO share_links \
         (id, project_id, owner_id, token_hash, token_prefix, mode, label, snapshot, \
          snapshot_bytes, allow_comments, allow_downloads, expires_at, revoked_at, created_at, \
          updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $13, $14)",
    )
    .bind(&id)
    .bind(project_id)
    .bind(owner_id)
    .bind(hash_token(token))
    .bind(&prefix)
    .bind(new.mode.as_str())
    .bind(&new.label)
    .bind(snapshot)
    .bind(snapshot_bytes)
    .bind(new.allow_comments)
    .bind(new.allow_downloads)
    .bind(new.expires_at)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(ShareSummary {
        id,
        token_prefix: prefix,
        mode: new.mode,
        label: new.label.clone(),
        allow_comments: new.allow_comments,
        allow_downloads: new.allow_downloads,
        expires_at: new.expires_at,
        created_at: now,
        revoked_at: None,
        unresolved_comments: 0,
    })
}

pub async fn list(
    db: &Db,
    owner_id: &str,
    project_id: &str,
) -> Result<Vec<ShareSummary>, ShareError> {
    project_is_owned(db, owner_id, project_id).await?;
    let rows = sqlx::query(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM share_links s \
         WHERE s.project_id = $1 AND s.owner_id = $2 ORDER BY s.created_at DESC, s.id DESC"
    ))
    .bind(project_id)
    .bind(owner_id)
    .fetch_all(db.pool())
    .await?;
    rows.iter()
        .map(summary_from_row)
        .collect::<Result<_, _>>()
        .map_err(Into::into)
}

pub async fn get(
    db: &Db,
    owner_id: &str,
    project_id: &str,
    share_id: &str,
) -> Result<ShareSummary, ShareError> {
    let row = sqlx::query(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM share_links s \
         WHERE s.id = $1 AND s.project_id = $2 AND s.owner_id = $3"
    ))
    .bind(share_id)
    .bind(project_id)
    .bind(owner_id)
    .fetch_optional(db.pool())
    .await?
    .ok_or(ShareError::NotFound)?;
    Ok(summary_from_row(&row)?)
}

/// A revoked link is `NotFound`: it is permanent, so editing it would suggest it can come back.
pub async fn update(
    db: &Db,
    owner_id: &str,
    project_id: &str,
    share_id: &str,
    edit: &ShareEdit,
) -> Result<ShareSummary, ShareError> {
    let updated = sqlx::query(
        "UPDATE share_links SET label = $1, expires_at = $2, allow_comments = $3, \
         allow_downloads = $4, updated_at = $5 \
         WHERE id = $6 AND project_id = $7 AND owner_id = $8 AND revoked_at IS NULL",
    )
    .bind(&edit.label)
    .bind(edit.expires_at)
    .bind(edit.allow_comments)
    .bind(edit.allow_downloads)
    .bind(now_ms())
    .bind(share_id)
    .bind(project_id)
    .bind(owner_id)
    .execute(db.pool())
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ShareError::NotFound);
    }
    get(db, owner_id, project_id, share_id).await
}

/// Clearing the snapshot frees the owner's quota while the row stays for its comments.
pub async fn revoke(
    db: &Db,
    owner_id: &str,
    project_id: &str,
    share_id: &str,
) -> Result<(), ShareError> {
    let now = now_ms();
    let revoked = sqlx::query(
        "UPDATE share_links SET revoked_at = COALESCE(revoked_at, $1), snapshot = NULL, \
         snapshot_bytes = 0, updated_at = $2 \
         WHERE id = $3 AND project_id = $4 AND owner_id = $5",
    )
    .bind(now)
    .bind(now)
    .bind(share_id)
    .bind(project_id)
    .bind(owner_id)
    .execute(db.pool())
    .await?;
    if revoked.rows_affected() == 0 {
        return Err(ShareError::NotFound);
    }
    Ok(())
}

/// Revoked, expired, unknown, and malformed tokens all return `None`, so the
/// caller cannot tell them apart and neither can a listener.
pub async fn find_active(
    db: &Db,
    token: &str,
    now: i64,
) -> Result<Option<ActiveShare>, ShareError> {
    if !is_well_formed(token) {
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT s.id, s.project_id, s.mode, s.snapshot, s.allow_comments, s.allow_downloads, \
         s.expires_at, s.created_at, p.song, p.revision, p.updated_at AS project_updated_at \
         FROM share_links s JOIN projects p ON p.id = s.project_id \
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL \
         AND (s.expires_at IS NULL OR s.expires_at > $2)",
    )
    .bind(hash_token(token))
    .bind(now)
    .fetch_optional(db.pool())
    .await?;
    let Some(row) = row else { return Ok(None) };

    let mode = ShareMode::parse(&row.try_get::<String, _>("mode")?)?;
    let (mut song, project_revision, shared_at) = match mode {
        ShareMode::Snapshot => {
            let snapshot: Option<String> = row.try_get("snapshot")?;
            let snapshot = snapshot
                .ok_or_else(|| ShareError::Projection("a snapshot link has no snapshot".into()))?;
            let song = serde_json::from_str(&snapshot)
                .map_err(|e| ShareError::Projection(json_error_kind(&e)))?;
            (song, None, row.try_get("created_at")?)
        }
        ShareMode::Live => {
            let stored: String = row.try_get("song")?;
            (
                project_song(&stored)?,
                Some(row.try_get("revision")?),
                row.try_get("project_updated_at")?,
            )
        }
    };
    let id: String = row.try_get("id")?;
    // A song's id is its project's id, which a listener must never learn; the
    // share id stands in so the document still has a stable identifier.
    if let Some(object) = song.as_object_mut() {
        object.insert("id".into(), Value::String(id.clone()));
    }
    Ok(Some(ActiveShare {
        id,
        project_id: row.try_get("project_id")?,
        mode,
        allow_comments: decode_bool(&row, "allow_comments")?,
        allow_downloads: decode_bool(&row, "allow_downloads")?,
        expires_at: row.try_get("expires_at")?,
        song,
        project_revision,
        shared_at,
    }))
}

/// The share row is touched first so concurrent posts to one link are
/// serialised and cannot both pass the cap check.
pub async fn add_comment(
    db: &Db,
    share_id: &str,
    project_id: &str,
    comment: &NewComment,
) -> Result<StoredComment, ShareError> {
    let now = now_ms();
    let id = uuid::Uuid::now_v7().to_string();
    let mut tx = db.pool().begin().await?;
    // Re-checks everything `find_active` and the handler decided on, because the owner may have
    // switched comments off, expired, or revoked the link since that lookup.
    let locked = sqlx::query(
        "UPDATE share_links SET updated_at = updated_at WHERE id = $1 AND revoked_at IS NULL \
         AND allow_comments = $2 AND (expires_at IS NULL OR expires_at > $3)",
    )
    .bind(share_id)
    .bind(true)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    if locked.rows_affected() == 0 {
        return Err(ShareError::NotFound);
    }
    let held: i64 = sqlx::query("SELECT COUNT(*) AS n FROM share_comments WHERE share_id = $1")
        .bind(share_id)
        .fetch_one(&mut *tx)
        .await?
        .try_get("n")?;
    if held >= MAX_COMMENTS_PER_SHARE {
        return Err(ShareError::CommentLimit);
    }
    sqlx::query(
        "INSERT INTO share_comments \
         (id, share_id, project_id, author_name, body, at_step, section_id, section_name, \
          project_revision, created_at, resolved_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)",
    )
    .bind(&id)
    .bind(share_id)
    .bind(project_id)
    .bind(&comment.name)
    .bind(&comment.body)
    .bind(comment.at_step)
    .bind(&comment.section_id)
    .bind(&comment.section_name)
    .bind(comment.project_revision)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StoredComment {
        id,
        created_at: now,
    })
}

const COMMENT_COLUMNS: &str = "c.id, c.share_id, s.label AS share_label, s.token_prefix, \
     c.author_name, c.body, CAST(c.at_step AS BIGINT) AS at_step, c.section_id, c.section_name, \
     c.project_revision, c.created_at, c.resolved_at";

fn comment_from_row(row: &AnyRow) -> Result<OwnerComment, sqlx::Error> {
    Ok(OwnerComment {
        id: row.try_get("id")?,
        share_id: row.try_get("share_id")?,
        share_label: row.try_get("share_label")?,
        token_prefix: row.try_get("token_prefix")?,
        name: row.try_get("author_name")?,
        body: row.try_get("body")?,
        at_step: row.try_get("at_step")?,
        section_id: row.try_get("section_id")?,
        section_name: row.try_get("section_name")?,
        project_revision: row.try_get("project_revision")?,
        created_at: row.try_get("created_at")?,
        resolved_at: row.try_get("resolved_at")?,
    })
}

pub async fn list_comments(
    db: &Db,
    owner_id: &str,
    project_id: &str,
) -> Result<Vec<OwnerComment>, ShareError> {
    project_is_owned(db, owner_id, project_id).await?;
    let rows = sqlx::query(&format!(
        "SELECT {COMMENT_COLUMNS} FROM share_comments c \
         JOIN share_links s ON s.id = c.share_id \
         WHERE c.project_id = $1 AND s.owner_id = $2 \
         ORDER BY c.at_step, c.created_at, c.id"
    ))
    .bind(project_id)
    .bind(owner_id)
    .fetch_all(db.pool())
    .await?;
    rows.iter()
        .map(comment_from_row)
        .collect::<Result<_, _>>()
        .map_err(Into::into)
}

pub async fn set_comment_resolved(
    db: &Db,
    owner_id: &str,
    project_id: &str,
    comment_id: &str,
    resolved: bool,
) -> Result<OwnerComment, ShareError> {
    // Resolving twice keeps the first time, so the owner sees when it was first handled.
    let updated = if resolved {
        sqlx::query(
            "UPDATE share_comments SET resolved_at = COALESCE(resolved_at, $1) \
             WHERE id = $2 AND project_id = $3 \
             AND share_id IN (SELECT id FROM share_links WHERE owner_id = $4)",
        )
        .bind(now_ms())
        .bind(comment_id)
        .bind(project_id)
        .bind(owner_id)
        .execute(db.pool())
        .await?
    } else {
        sqlx::query(
            "UPDATE share_comments SET resolved_at = NULL \
             WHERE id = $1 AND project_id = $2 \
             AND share_id IN (SELECT id FROM share_links WHERE owner_id = $3)",
        )
        .bind(comment_id)
        .bind(project_id)
        .bind(owner_id)
        .execute(db.pool())
        .await?
    };
    if updated.rows_affected() == 0 {
        return Err(ShareError::NotFound);
    }
    let row = sqlx::query(&format!(
        "SELECT {COMMENT_COLUMNS} FROM share_comments c \
         JOIN share_links s ON s.id = c.share_id \
         WHERE c.id = $1 AND c.project_id = $2 AND s.owner_id = $3"
    ))
    .bind(comment_id)
    .bind(project_id)
    .bind(owner_id)
    .fetch_optional(db.pool())
    .await?
    .ok_or(ShareError::NotFound)?;
    Ok(comment_from_row(&row)?)
}

pub async fn delete_comment(
    db: &Db,
    owner_id: &str,
    project_id: &str,
    comment_id: &str,
) -> Result<(), ShareError> {
    let deleted = sqlx::query(
        "DELETE FROM share_comments WHERE id = $1 AND project_id = $2 \
         AND share_id IN (SELECT id FROM share_links WHERE owner_id = $3)",
    )
    .bind(comment_id)
    .bind(project_id)
    .bind(owner_id)
    .execute(db.pool())
    .await?;
    if deleted.rows_affected() == 0 {
        return Err(ShareError::NotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const PUBLIC_SONG_FIELDS: [&str; 14] = [
        "version",
        "id",
        "name",
        "tempo_bpm",
        "time_signature",
        "steps_per_measure",
        "swing",
        "key",
        "measures",
        "loop_region",
        "tracks",
        "samples",
        "lyrics",
        "sections",
    ];

    fn full_song() -> Value {
        json!({
            "version": 2, "id": "p", "name": "Demo", "tempo_bpm": 96,
            "time_signature": "4/4", "steps_per_measure": 16, "swing": 0,
            "key": {"tonic": "C", "mode": "major"},
            "measures": 2,
            "loop_region": {"region": null, "enabled": false},
            "tracks": [],
            "samples": [{"id": "s1", "name": "Hit", "sample_rate": 48000, "channels": 1,
                         "length_samples": 100, "origin": "import"}],
            "chat": [{"role": "user", "content": "private chat"}],
            "lyric_chat": [{"role": "user", "content": "private lyric chat"}],
            "lyrics": "la la",
            "sections": [{"id": "a", "name": "Verse", "kind": "verse", "measures": 2,
                          "notes": "private note"}],
        })
    }

    #[test]
    fn projection_removes_exactly_the_working_material() {
        let projected = project_song(&full_song().to_string()).unwrap();
        let mut expected = full_song();
        expected.as_object_mut().unwrap().remove("chat");
        expected.as_object_mut().unwrap().remove("lyric_chat");
        expected["sections"][0]
            .as_object_mut()
            .unwrap()
            .remove("notes");
        assert_eq!(projected, expected);
    }

    #[test]
    fn projection_keeps_fields_this_build_does_not_know() {
        let mut song = full_song();
        song["from_the_future"] = json!({"kept": true});
        song["sections"][0]["also_new"] = json!(7);
        let projected = project_song(&song.to_string()).unwrap();
        assert_eq!(projected["from_the_future"], json!({"kept": true}));
        assert_eq!(projected["sections"][0]["also_new"], json!(7));
    }

    #[test]
    fn projection_refuses_what_is_not_a_song() {
        assert!(project_song("{\"name\": 3}").is_err());
        assert!(project_song("[]").is_err());
    }

    /// A field added to `Song` must be classified here as public or private, or
    /// it would reach every listener by default. The exhaustive destructuring
    /// stops compiling when a field is added, which is the prompt to update
    /// `PUBLIC_SONG_FIELDS` or `PRIVATE_SONG_FIELDS`.
    #[test]
    fn every_song_field_is_classified_as_public_or_private() {
        let song: Song = serde_json::from_value(full_song()).unwrap();
        let Song {
            version: _,
            id: _,
            name: _,
            tempo_bpm: _,
            time_signature: _,
            steps_per_measure: _,
            swing: _,
            key: _,
            measures: _,
            loop_region: _,
            tracks: _,
            samples: _,
            chat: _,
            lyric_chat: _,
            lyrics: _,
            sections: _,
        } = song.clone();

        let serialized = serde_json::to_value(&song).unwrap();
        let mut fields: Vec<&str> = serialized
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        let mut classified: Vec<&str> = PUBLIC_SONG_FIELDS
            .iter()
            .chain(PRIVATE_SONG_FIELDS.iter())
            .copied()
            .collect();
        classified.sort_unstable();
        assert_eq!(
            fields, classified,
            "classify every Song field as public or private"
        );
    }
}
