//! Operator-side work on stored keys: moving them to the current master key, and discarding
//! those whose master key is gone. Neither ever shows a key.

use std::future::Future;

use sqlx::Row;

use super::crypto::{decrypt, encrypt, EncryptedKey};
use super::{AiProvider, KeyStoreError};
use crate::clock::now_ms;
use crate::config::Keyring;
use crate::db::Db;

/// Counts only, so the command's output is safe to paste into a ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RotationReport {
    pub rewritten: u64,
    pub already_current: u64,
    pub undecryptable: u64,
}

struct Candidate {
    user_id: String,
    provider: AiProvider,
    stored: EncryptedKey,
}

pub async fn rotate(db: &Db, keyring: &Keyring) -> Result<RotationReport, KeyStoreError> {
    rotate_with_hook(db, keyring, || async {}).await
}

/// `between_read_and_write` runs after the rows are read and before any is rewritten, so a
/// test can simulate a user saving a key mid-rotation.
#[doc(hidden)]
pub async fn rotate_with_hook<F, Fut>(
    db: &Db,
    keyring: &Keyring,
    between_read_and_write: F,
) -> Result<RotationReport, KeyStoreError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    let rows = sqlx::query(
        "SELECT user_id, provider, key_version, nonce, ciphertext FROM user_api_keys \
         ORDER BY user_id, provider",
    )
    .fetch_all(db.pool())
    .await?;
    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let provider: String = row.try_get(1)?;
        let Ok(provider) = provider.parse() else {
            continue;
        };
        candidates.push(Candidate {
            user_id: row.try_get(0)?,
            provider,
            stored: EncryptedKey {
                key_version: row.try_get(2)?,
                nonce: row.try_get(3)?,
                ciphertext: row.try_get(4)?,
            },
        });
    }
    between_read_and_write().await;

    let current = keyring.current().0.to_string();
    let mut report = RotationReport::default();
    for row in candidates {
        if row.stored.key_version == current {
            report.already_current += 1;
            continue;
        }
        let Ok(plaintext) = decrypt(keyring, &row.user_id, row.provider, &row.stored) else {
            report.undecryptable += 1;
            continue;
        };
        let Ok(sealed) = encrypt(keyring, &row.user_id, row.provider, &plaintext) else {
            report.undecryptable += 1;
            continue;
        };
        // Conditional on the version that was read: a save that replaced the row since
        // then holds a newer key, and rewriting would put the old one back.
        let updated = sqlx::query(
            "UPDATE user_api_keys SET key_version = $1, nonce = $2, ciphertext = $3 \
             WHERE user_id = $4 AND provider = $5 AND key_version = $6 AND ciphertext = $7",
        )
        .bind(&sealed.key_version)
        .bind(&sealed.nonce)
        .bind(&sealed.ciphertext)
        .bind(&row.user_id)
        .bind(row.provider.as_str())
        .bind(&row.stored.key_version)
        .bind(&row.stored.ciphertext)
        .execute(db.pool())
        .await?;
        if updated.rows_affected() == 1 {
            report.rewritten += 1;
        } else {
            report.already_current += 1;
        }
    }
    Ok(report)
}

pub async fn count_with_version(db: &Db, version: &str) -> Result<u64, KeyStoreError> {
    let row =
        sqlx::query("SELECT CAST(COUNT(*) AS BIGINT) FROM user_api_keys WHERE key_version = $1")
            .bind(version)
            .fetch_one(db.pool())
            .await?;
    Ok(u64::try_from(row.try_get::<i64, _>(0)?).unwrap_or(0))
}

/// What is left after a rotation, so the operator knows whether an old key can be dropped.
pub async fn count_not_on_version(db: &Db, version: &str) -> Result<u64, KeyStoreError> {
    let row =
        sqlx::query("SELECT CAST(COUNT(*) AS BIGINT) FROM user_api_keys WHERE key_version <> $1")
            .bind(version)
            .fetch_one(db.pool())
            .await?;
    Ok(u64::try_from(row.try_get::<i64, _>(0)?).unwrap_or(0))
}

/// Users left with a dangling active choice fall back to the key they still have, in the same
/// transaction, so nobody is left pointing at a key that no longer exists.
pub async fn purge_version(db: &Db, version: &str) -> Result<u64, KeyStoreError> {
    let mut tx = db.pool().begin().await?;
    // Settings rows are locked before key rows, the same order `upsert` and `delete` use;
    // taking them in the opposite order lets a save running during a purge deadlock on
    // Postgres and get aborted. Every key owner has a settings row because each write that
    // creates a key also creates that row.
    sqlx::query(
        "UPDATE user_ai_settings SET updated_at = $2 WHERE user_id IN \
         (SELECT user_id FROM user_api_keys WHERE key_version = $1)",
    )
    .bind(version)
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    let deleted = sqlx::query("DELETE FROM user_api_keys WHERE key_version = $1")
        .bind(version)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE user_ai_settings SET updated_at = $1, active_provider = \
         (SELECT k.provider FROM user_api_keys k WHERE k.user_id = user_ai_settings.user_id \
          ORDER BY k.provider LIMIT 1) \
         WHERE active_provider IS NOT NULL AND NOT EXISTS \
         (SELECT 1 FROM user_api_keys k WHERE k.user_id = user_ai_settings.user_id \
          AND k.provider = user_ai_settings.active_provider)",
    )
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(deleted.rows_affected())
}
