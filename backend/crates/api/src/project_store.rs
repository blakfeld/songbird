//! Every query here is scoped by `owner_id`, including the follow-up read after
//! a failed conditional update, so no path can reveal that another user's
//! project exists.

use sqlx::any::AnyRow;
use sqlx::Row;

use crate::clock::now_ms;
use crate::db::Db;

pub const MAX_PROJECTS_PER_USER: i64 = 500;
pub const MAX_STORED_BYTES_PER_USER: i64 = 100 * 1024 * 1024;
/// The client's 300 ms debounce keeps ordinary editing well under this.
pub const MIN_SAVE_INTERVAL_MS: i64 = 1000;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("no such project")]
    NotFound,
    #[error("revision conflict")]
    RevisionConflict,
    #[error("project limit")]
    Limit,
    #[error("saved too soon")]
    TooSoon { retry_after_secs: u64 },
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub time_signature: String,
    pub track_count: i64,
    pub revision: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub id: String,
    pub revision: i64,
    pub updated_at: i64,
    pub song: String,
}

/// Columns copied out of the song on every write so listing and quota checks never parse it.
#[derive(Debug, Clone)]
pub struct SongFacts {
    pub name: String,
    pub time_signature: String,
    pub track_count: i32,
    pub song_json: String,
}

impl SongFacts {
    fn size_bytes(&self) -> i64 {
        i64::try_from(self.song_json.len()).unwrap_or(i64::MAX)
    }
}

pub async fn list(db: &Db, owner_id: &str) -> Result<Vec<Summary>, ProjectError> {
    let rows = sqlx::query(
        "SELECT id, name, time_signature, CAST(track_count AS BIGINT) AS track_count, revision, updated_at \
         FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC",
    )
    .bind(owner_id)
    .fetch_all(db.pool())
    .await?;
    rows.iter()
        .map(|row| {
            Ok(Summary {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                time_signature: row.try_get("time_signature")?,
                track_count: row.try_get("track_count")?,
                revision: row.try_get("revision")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(Into::into)
}

pub async fn get(db: &Db, owner_id: &str, id: &str) -> Result<Stored, ProjectError> {
    let row = sqlx::query(
        "SELECT id, revision, updated_at, song FROM projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(db.pool())
    .await?
    .ok_or(ProjectError::NotFound)?;
    stored_from_row(&row).map_err(Into::into)
}

fn stored_from_row(row: &AnyRow) -> Result<Stored, sqlx::Error> {
    Ok(Stored {
        id: row.try_get("id")?,
        revision: row.try_get("revision")?,
        updated_at: row.try_get("updated_at")?,
        song: row.try_get("song")?,
    })
}

/// Touching the owner's row first takes a row lock on Postgres and the write
/// lock on SQLite, so two concurrent writes for one user cannot both pass a
/// count check that only one should, without `FOR UPDATE` (which SQLite lacks).
async fn lock_owner(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    owner_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE users SET updated_at = updated_at WHERE id = $1")
        .bind(owner_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn count_and_bytes(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    owner_id: &str,
) -> Result<(i64, i64), sqlx::Error> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS n, CAST(COALESCE(SUM(size_bytes), 0) AS BIGINT) AS bytes \
         FROM projects WHERE owner_id = $1",
    )
    .bind(owner_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok((row.try_get("n")?, row.try_get("bytes")?))
}

pub async fn create(
    db: &Db,
    owner_id: &str,
    id: &str,
    facts: &SongFacts,
) -> Result<Stored, ProjectError> {
    let now = now_ms();
    let mut tx = db.pool().begin().await?;
    lock_owner(&mut tx, owner_id).await?;
    let (count, bytes) = count_and_bytes(&mut tx, owner_id).await?;
    if count >= MAX_PROJECTS_PER_USER
        || bytes.saturating_add(facts.size_bytes()) > MAX_STORED_BYTES_PER_USER
    {
        return Err(ProjectError::Limit);
    }
    sqlx::query(
        "INSERT INTO projects \
         (id, owner_id, name, time_signature, track_count, song, size_bytes, revision, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(&facts.name)
    .bind(&facts.time_signature)
    .bind(facts.track_count)
    .bind(&facts.song_json)
    .bind(facts.size_bytes())
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Stored {
        id: id.to_string(),
        revision: 1,
        updated_at: now,
        song: facts.song_json.clone(),
    })
}

pub struct Saved {
    pub revision: i64,
    pub updated_at: i64,
}

pub async fn update(
    db: &Db,
    owner_id: &str,
    id: &str,
    expected_revision: i64,
    facts: &SongFacts,
) -> Result<Saved, ProjectError> {
    let now = now_ms();
    let mut tx = db.pool().begin().await?;
    lock_owner(&mut tx, owner_id).await?;

    let updated = sqlx::query(
        "UPDATE projects SET name = $1, time_signature = $2, track_count = $3, song = $4, \
         size_bytes = $5, revision = revision + 1, updated_at = $6 \
         WHERE id = $7 AND owner_id = $8 AND revision = $9 AND updated_at <= $10",
    )
    .bind(&facts.name)
    .bind(&facts.time_signature)
    .bind(facts.track_count)
    .bind(&facts.song_json)
    .bind(facts.size_bytes())
    .bind(now)
    .bind(id)
    .bind(owner_id)
    .bind(expected_revision)
    .bind(now - MIN_SAVE_INTERVAL_MS)
    .execute(&mut *tx)
    .await?;

    if updated.rows_affected() == 0 {
        let current = sqlx::query(
            "SELECT revision, updated_at FROM projects WHERE id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(owner_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ProjectError::NotFound)?;
        let revision: i64 = current.try_get("revision")?;
        if revision != expected_revision {
            return Err(ProjectError::RevisionConflict);
        }
        let updated_at: i64 = current.try_get("updated_at")?;
        let wait_ms = (updated_at + MIN_SAVE_INTERVAL_MS - now).max(1);
        return Err(ProjectError::TooSoon {
            retry_after_secs: u64::try_from(wait_ms / 1000).unwrap_or(0) + 1,
        });
    }

    let (_, bytes) = count_and_bytes(&mut tx, owner_id).await?;
    if bytes > MAX_STORED_BYTES_PER_USER {
        // Returning without commit is what undoes the over-quota write.
        return Err(ProjectError::Limit);
    }
    tx.commit().await?;
    Ok(Saved {
        revision: expected_revision + 1,
        updated_at: now,
    })
}

pub async fn delete(db: &Db, owner_id: &str, id: &str) -> Result<(), ProjectError> {
    let deleted = sqlx::query("DELETE FROM projects WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(owner_id)
        .execute(db.pool())
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(ProjectError::NotFound);
    }
    Ok(())
}
