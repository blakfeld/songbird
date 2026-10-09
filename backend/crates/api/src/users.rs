//! Account storage. Emails are normalised here, not in SQL, because
//! `COLLATE NOCASE`/`citext` do not exist on both backends.

use sqlx::any::AnyRow;
use sqlx::Row;

use crate::clock::now_ms;
use crate::db::Db;

const MAX_EMAIL_CHARS: usize = 254;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub email: String,
    pub password_hash: String,
    pub disabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum UserError {
    #[error("That email is already in use.")]
    EmailInUse,
    #[error("No account has that email.")]
    NotFound,
    #[error("\"{0}\" is not a valid email address.")]
    InvalidEmail(String),
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// Applied to every write and lookup so the plain `UNIQUE` index is case-insensitive.
pub fn normalize_email(raw: &str) -> Result<String, UserError> {
    let email = raw.trim().to_lowercase();
    let well_formed = email.chars().count() <= MAX_EMAIL_CHARS
        && !email.chars().any(char::is_whitespace)
        && email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty());
    if well_formed {
        Ok(email)
    } else {
        Err(UserError::InvalidEmail(raw.trim().to_string()))
    }
}

pub async fn create(db: &Db, email: &str, password_hash: &str) -> Result<User, UserError> {
    let email = normalize_email(email)?;
    let now = now_ms();
    let user = User {
        id: uuid::Uuid::now_v7().to_string(),
        email,
        password_hash: password_hash.to_string(),
        disabled: false,
        created_at: now,
        updated_at: now,
    };
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, disabled, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&user.id)
    .bind(&user.email)
    .bind(&user.password_hash)
    .bind(user.disabled)
    .bind(user.created_at)
    .bind(user.updated_at)
    .execute(db.pool())
    .await
    .map_err(|e| {
        // Detected through sqlx rather than error-code strings, which differ per backend.
        if e.as_database_error()
            .is_some_and(|d| d.is_unique_violation())
        {
            UserError::EmailInUse
        } else {
            UserError::Database(e)
        }
    })?;
    Ok(user)
}

pub async fn find_by_email(db: &Db, email: &str) -> Result<Option<User>, UserError> {
    let email = normalize_email(email)?;
    let row = sqlx::query(&format!("SELECT {COLUMNS} FROM users WHERE email = $1"))
        .bind(email)
        .fetch_optional(db.pool())
        .await?;
    row.map(user_from_row).transpose().map_err(Into::into)
}

pub async fn list(db: &Db) -> Result<Vec<User>, UserError> {
    let rows = sqlx::query(&format!("SELECT {COLUMNS} FROM users ORDER BY email"))
        .fetch_all(db.pool())
        .await?;
    rows.into_iter()
        .map(user_from_row)
        .collect::<Result<_, _>>()
        .map_err(Into::into)
}

/// Sessions go in the same transaction so there is no moment where the new
/// password exists alongside a session minted under the old one.
pub async fn set_password(db: &Db, email: &str, password_hash: &str) -> Result<(), UserError> {
    let email = normalize_email(email)?;
    let mut tx = db.pool().begin().await?;
    let updated =
        sqlx::query("UPDATE users SET password_hash = $1, updated_at = $2 WHERE email = $3")
            .bind(password_hash)
            .bind(now_ms())
            .bind(&email)
            .execute(&mut *tx)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(UserError::NotFound);
    }
    delete_sessions_of(&mut tx, &email).await?;
    tx.commit().await?;
    Ok(())
}

/// Disabling ends sessions in the same transaction so a disabled account cannot
/// keep using a cookie it already holds.
pub async fn set_disabled(db: &Db, email: &str, disabled: bool) -> Result<(), UserError> {
    let email = normalize_email(email)?;
    let mut tx = db.pool().begin().await?;
    let updated = sqlx::query("UPDATE users SET disabled = $1, updated_at = $2 WHERE email = $3")
        .bind(disabled)
        .bind(now_ms())
        .bind(&email)
        .execute(&mut *tx)
        .await?;
    if updated.rows_affected() == 0 {
        return Err(UserError::NotFound);
    }
    if disabled {
        delete_sessions_of(&mut tx, &email).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Keeps sessions, unlike `set_password`: the password itself is unchanged, only
/// the hash parameters are being brought up to date.
pub async fn replace_hash(db: &Db, user_id: &str, password_hash: &str) -> Result<(), UserError> {
    sqlx::query("UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3")
        .bind(password_hash)
        .bind(now_ms())
        .bind(user_id)
        .execute(db.pool())
        .await?;
    Ok(())
}

/// Conditional on the hash that was verified, so a concurrent `set-password`
/// is not overwritten with a hash of the old password.
pub async fn replace_hash_if(
    db: &Db,
    user_id: &str,
    expected_hash: &str,
    new_hash: &str,
) -> Result<bool, UserError> {
    let result = sqlx::query(
        "UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3 AND password_hash = $4",
    )
    .bind(new_hash)
    .bind(now_ms())
    .bind(user_id)
    .bind(expected_hash)
    .execute(db.pool())
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Foreign keys cascade, so one statement removes the user's projects, sessions and usage.
pub async fn delete(db: &Db, email: &str) -> Result<(), UserError> {
    let email = normalize_email(email)?;
    let deleted = sqlx::query("DELETE FROM users WHERE email = $1")
        .bind(email)
        .execute(db.pool())
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(UserError::NotFound);
    }
    Ok(())
}

const COLUMNS: &str = "id, email, password_hash, disabled, created_at, updated_at";

async fn delete_sessions_of(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    email: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)")
        .bind(email)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn user_from_row(row: AnyRow) -> Result<User, sqlx::Error> {
    Ok(User {
        id: row.try_get("id")?,
        email: row.try_get("email")?,
        password_hash: row.try_get("password_hash")?,
        disabled: decode_bool(&row, "disabled")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// `Any` reports a SQLite `INTEGER` 0/1 as a number, which it refuses to decode
/// as `bool`, while Postgres `BOOLEAN` decodes as `bool` only.
pub(crate) fn decode_bool(row: &AnyRow, column: &str) -> Result<bool, sqlx::Error> {
    row.try_get::<bool, _>(column)
        .or_else(|_| row.try_get::<i64, _>(column).map(|n| n != 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_trimmed_and_lowercased() {
        assert_eq!(
            normalize_email("  Ana@Example.COM ").unwrap(),
            "ana@example.com"
        );
    }

    #[test]
    fn malformed_emails_are_rejected() {
        for bad in [
            "",
            "   ",
            "no-at-sign",
            "@example.com",
            "ana@",
            "a b@example.com",
        ] {
            assert!(
                matches!(normalize_email(bad), Err(UserError::InvalidEmail(_))),
                "{bad}"
            );
        }
        let too_long = format!("{}@example.com", "a".repeat(250));
        assert!(normalize_email(&too_long).is_err());
    }
}
