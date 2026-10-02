//! Every write that touches both tables runs in one transaction, or as one statement,
//! so a reader never sees a key without the active-provider choice that goes with it.

use sqlx::any::AnyRow;
use sqlx::Row;

use super::crypto::EncryptedKey;
use super::AiProvider;
use crate::clock::now_ms;
use crate::db::Db;

#[derive(Debug, thiserror::Error)]
pub enum KeyStoreError {
    #[error("the user has no key for that provider")]
    NoKeyForProvider,
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    pub provider: AiProvider,
    pub last4: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySummary {
    pub keys: Vec<KeyInfo>,
    pub active_provider: Option<AiProvider>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredKey {
    pub provider: AiProvider,
    pub encrypted: EncryptedKey,
}

fn provider_from(raw: String) -> Result<AiProvider, sqlx::Error> {
    raw.parse().map_err(|()| {
        sqlx::Error::Decode(format!("stored provider \"{raw}\" is not supported").into())
    })
}

/// One query so the keys and the active choice come from the same snapshot.
pub async fn summary(db: &Db, user_id: &str) -> Result<KeySummary, KeyStoreError> {
    let rows = sqlx::query(
        "SELECT k.provider, k.last4, k.updated_at, s.active_provider \
         FROM user_api_keys k \
         LEFT JOIN user_ai_settings s ON s.user_id = k.user_id \
         WHERE k.user_id = $1 ORDER BY k.provider",
    )
    .bind(user_id)
    .fetch_all(db.pool())
    .await?;
    let mut keys = Vec::with_capacity(rows.len());
    let mut recorded = None;
    for row in rows {
        keys.push(KeyInfo {
            provider: provider_from(row.try_get(0)?)?,
            last4: row.try_get(1)?,
            updated_at: row.try_get(2)?,
        });
        recorded = row
            .try_get::<Option<String>, _>(3)?
            .map(provider_from)
            .transpose()?;
    }
    // A recorded choice with no key behind it must not be shown as active, whatever wrote it.
    let active_provider = recorded.filter(|p| keys.iter().any(|k| k.provider == *p));
    Ok(KeySummary {
        keys,
        active_provider,
    })
}

pub async fn active_key(db: &Db, user_id: &str) -> Result<Option<StoredKey>, KeyStoreError> {
    let row = sqlx::query(
        "SELECT k.provider, k.key_version, k.nonce, k.ciphertext \
         FROM user_api_keys k \
         JOIN user_ai_settings s ON s.user_id = k.user_id AND s.active_provider = k.provider \
         WHERE k.user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(db.pool())
    .await?;
    row.map(stored_from_row).transpose().map_err(Into::into)
}

fn stored_from_row(row: AnyRow) -> Result<StoredKey, sqlx::Error> {
    Ok(StoredKey {
        provider: provider_from(row.try_get(0)?)?,
        encrypted: EncryptedKey {
            key_version: row.try_get(1)?,
            nonce: row.try_get(2)?,
            ciphertext: row.try_get(3)?,
        },
    })
}

/// Taking the user's settings row lock first serializes every write that touches their keys
/// or their active choice. Without it, under READ COMMITTED a concurrent `set_active` can read
/// a key that a `delete` is removing, while the delete's follow-up update matches nothing and
/// so takes no lock, leaving an active provider with no key behind it.
async fn lock_user(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user_id: &str,
    now: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO user_ai_settings (user_id, active_provider, updated_at) \
         VALUES ($1, NULL, $2) \
         ON CONFLICT (user_id) DO UPDATE SET updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Keeps the active provider only while a key for it exists, otherwise falls back to the
/// key that is left. Run after the key rows change, under the user lock.
const NORMALIZE_ACTIVE: &str = "UPDATE user_ai_settings SET updated_at = $2, active_provider = \
     CASE WHEN EXISTS (SELECT 1 FROM user_api_keys k WHERE k.user_id = $1 \
                       AND k.provider = user_ai_settings.active_provider) \
          THEN active_provider \
          ELSE (SELECT provider FROM user_api_keys WHERE user_id = $1 \
                ORDER BY provider LIMIT 1) END \
     WHERE user_id = $1";

pub async fn upsert(
    db: &Db,
    user_id: &str,
    provider: AiProvider,
    encrypted: &EncryptedKey,
    last4: &str,
) -> Result<(), KeyStoreError> {
    let now = now_ms();
    let mut tx = db.pool().begin().await?;
    lock_user(&mut tx, user_id, now).await?;
    sqlx::query(
        "INSERT INTO user_api_keys \
         (user_id, provider, key_version, nonce, ciphertext, last4, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) \
         ON CONFLICT (user_id, provider) DO UPDATE SET \
         key_version = excluded.key_version, nonce = excluded.nonce, \
         ciphertext = excluded.ciphertext, last4 = excluded.last4, \
         updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(provider.as_str())
    .bind(&encrypted.key_version)
    .bind(&encrypted.nonce)
    .bind(&encrypted.ciphertext)
    .bind(last4)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    // Keeping a valid choice means saving a second key never silently switches billing accounts.
    sqlx::query(
        "UPDATE user_ai_settings SET updated_at = $3, active_provider = \
         CASE WHEN EXISTS (SELECT 1 FROM user_api_keys k WHERE k.user_id = $1 \
                           AND k.provider = user_ai_settings.active_provider) \
              THEN active_provider ELSE CAST($2 AS TEXT) END \
         WHERE user_id = $1",
    )
    .bind(user_id)
    .bind(provider.as_str())
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Idempotent. At most one key can remain afterwards, so the fallback is whatever is left.
pub async fn delete(db: &Db, user_id: &str, provider: AiProvider) -> Result<(), KeyStoreError> {
    let now = now_ms();
    let mut tx = db.pool().begin().await?;
    lock_user(&mut tx, user_id, now).await?;
    sqlx::query("DELETE FROM user_api_keys WHERE user_id = $1 AND provider = $2")
        .bind(user_id)
        .bind(provider.as_str())
        .execute(&mut *tx)
        .await?;
    sqlx::query(NORMALIZE_ACTIVE)
        .bind(user_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Fails without committing when the key is missing, which also rolls back the lock row so a
/// user with no keys gains no settings row from a failed attempt.
pub async fn set_active(db: &Db, user_id: &str, provider: AiProvider) -> Result<(), KeyStoreError> {
    let now = now_ms();
    let mut tx = db.pool().begin().await?;
    lock_user(&mut tx, user_id, now).await?;
    let result = sqlx::query(
        "UPDATE user_ai_settings SET active_provider = $2, updated_at = $3 \
         WHERE user_id = $1 AND EXISTS \
         (SELECT 1 FROM user_api_keys WHERE user_id = $1 AND provider = $2)",
    )
    .bind(user_id)
    .bind(provider.as_str())
    .bind(now)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(KeyStoreError::NoKeyForProvider);
    }
    tx.commit().await?;
    Ok(())
}

/// For the startup check that every stored key's master version is still in the keyring.
pub async fn key_versions_in_use(db: &Db) -> Result<Vec<String>, KeyStoreError> {
    let rows = sqlx::query("SELECT DISTINCT key_version FROM user_api_keys ORDER BY key_version")
        .fetch_all(db.pool())
        .await?;
    rows.iter()
        .map(|r| r.try_get(0).map_err(Into::into))
        .collect()
}
