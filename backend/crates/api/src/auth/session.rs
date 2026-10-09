use std::time::Duration;

use secrecy::{ExposeSecret, SecretString};
use sqlx::Row;

use crate::clock::now_ms;
use crate::db::Db;
// Re-exported so existing callers keep one import path for session credentials.
pub use crate::token::{generate_token, hash_token, sha256_hex};

/// `__Host-` makes browsers refuse the cookie unless it is `Secure`, `Path=/`
/// and domain-less, so a sibling subdomain cannot plant it.
pub const SECURE_COOKIE_NAME: &str = "__Host-songbird_session";
/// Browsers reject `__Host-` cookies over plain http, so development needs its own name.
pub const PLAIN_COOKIE_NAME: &str = "songbird_session";

/// Bounds a stolen-but-kept-alive session regardless of the sliding idle window.
pub const ABSOLUTE_LIFETIME: Duration = Duration::from_secs(30 * 24 * 3600);

/// Avoids a database write on every request while still sliding the idle window.
const BUMP_INTERVAL_MS: i64 = 60_000;

const SWEEP_INTERVAL: Duration = Duration::from_secs(3600);

pub fn cookie_name(secure: bool) -> &'static str {
    if secure {
        SECURE_COOKIE_NAME
    } else {
        PLAIN_COOKIE_NAME
    }
}

/// A new session never outlives the absolute cap, even with a long idle window.
pub fn initial_expiry_ms(now_ms: i64, idle: Duration) -> i64 {
    expiry_ms(now_ms, now_ms, idle)
}

/// The idle window slides forward from `now_ms`, but never past the cap measured from login.
fn expiry_ms(created_at: i64, now_ms: i64, idle: Duration) -> i64 {
    now_ms
        .saturating_add(duration_ms(idle))
        .min(created_at.saturating_add(duration_ms(ABSOLUTE_LIFETIME)))
}

fn duration_ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// The browser's cookie outlives a browser restart for as long as a session
/// could possibly live; the server decides when it actually ends.
pub fn set_cookie_header(secure: bool, token: &str) -> String {
    format!(
        "{}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}{}",
        cookie_name(secure),
        ABSOLUTE_LIFETIME.as_secs(),
        if secure { "; Secure" } else { "" }
    )
}

/// Browsers match a clearing cookie on name, path and attributes, so this repeats
/// every attribute the cookie was set with.
pub fn clear_cookie_header(secure: bool) -> String {
    format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT{}",
        cookie_name(secure),
        if secure { "; Secure" } else { "" }
    )
}

/// Returns the raw token, which exists only here and in the caller's `Set-Cookie`.
pub async fn create(
    db: &Db,
    user_id: &str,
    now_ms: i64,
    idle: Duration,
) -> Result<SecretString, sqlx::Error> {
    let token = generate_token();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(hash_token(token.expose_secret()))
    .bind(user_id)
    .bind(now_ms)
    .bind(now_ms)
    .bind(initial_expiry_ms(now_ms, idle))
    .execute(db.pool())
    .await?;
    Ok(token)
}

/// `None` when the account no longer has the verified hash or has been disabled.
/// An operator's `set-password` deletes sessions in its own transaction, so a
/// session inserted after that commit would otherwise survive the reset.
pub async fn create_if_credentials_unchanged(
    db: &Db,
    user_id: &str,
    verified_hash: &str,
    now_ms: i64,
    idle: Duration,
) -> Result<Option<SecretString>, sqlx::Error> {
    let token = generate_token();
    // Casts because Postgres cannot infer the type of a bare parameter in a SELECT list.
    let inserted = sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) \
         SELECT CAST($1 AS TEXT), CAST($2 AS TEXT), CAST($3 AS BIGINT), CAST($3 AS BIGINT), CAST($4 AS BIGINT) \
         WHERE EXISTS (SELECT 1 FROM users WHERE id = $2 AND password_hash = $5 AND disabled = $6)",
    )
    .bind(hash_token(token.expose_secret()))
    .bind(user_id)
    .bind(now_ms)
    .bind(initial_expiry_ms(now_ms, idle))
    .bind(verified_hash)
    .bind(false)
    .execute(db.pool())
    .await?;
    Ok((inserted.rows_affected() == 1).then_some(token))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionUser {
    pub id: String,
    pub email: String,
}

/// Disabled users are excluded by the join so a disable takes effect even if
/// a session row somehow survived.
pub async fn lookup(
    db: &Db,
    token: &str,
    now_ms: i64,
    idle: Duration,
) -> Result<Option<SessionUser>, sqlx::Error> {
    let token_hash = hash_token(token);
    let row = sqlx::query(
        "SELECT u.id, u.email, s.created_at, s.last_seen_at, s.expires_at \
         FROM sessions s JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = $1 AND u.disabled = $2",
    )
    .bind(&token_hash)
    .bind(false)
    .fetch_optional(db.pool())
    .await?;
    let Some(row) = row else { return Ok(None) };

    let created_at: i64 = row.try_get("created_at")?;
    let last_seen_at: i64 = row.try_get("last_seen_at")?;
    let expires_at: i64 = row.try_get("expires_at")?;
    let capped_at = created_at.saturating_add(duration_ms(ABSOLUTE_LIFETIME));
    if now_ms >= expires_at || now_ms >= capped_at {
        delete_by_hash(db, &token_hash).await?;
        return Ok(None);
    }

    if now_ms.saturating_sub(last_seen_at) >= BUMP_INTERVAL_MS {
        sqlx::query("UPDATE sessions SET last_seen_at = $1, expires_at = $2 WHERE token_hash = $3")
            .bind(now_ms)
            .bind(expiry_ms(created_at, now_ms, idle))
            .bind(&token_hash)
            .execute(db.pool())
            .await?;
    }
    Ok(Some(SessionUser {
        id: row.try_get("id")?,
        email: row.try_get("email")?,
    }))
}

pub async fn delete_by_token(db: &Db, token: &str) -> Result<(), sqlx::Error> {
    delete_by_hash(db, &hash_token(token)).await
}

async fn delete_by_hash(db: &Db, token_hash: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(token_hash)
        .execute(db.pool())
        .await?;
    Ok(())
}

/// Lazy deletion only removes sessions someone presents again; this clears the
/// ones whose cookies were simply abandoned.
pub async fn delete_ended(db: &Db, now_ms: i64) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at <= $1 OR created_at <= $2")
        .bind(now_ms)
        .bind(now_ms.saturating_sub(duration_ms(ABSOLUTE_LIFETIME)))
        .execute(db.pool())
        .await?;
    Ok(result.rows_affected())
}

pub fn spawn_sweeper(db: Db) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            match delete_ended(&db, now_ms()).await {
                Ok(0) => {}
                Ok(removed) => tracing::info!(removed, "swept ended sessions"),
                Err(error) => tracing::warn!(%error, "session sweep failed"),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_url_safe() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a.expose_secret(), b.expose_secret());
        assert_eq!(a.expose_secret().len(), 43);
        assert!(a
            .expose_secret()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn hash_is_hex_sha256_of_the_token() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn idle_window_is_capped_at_the_absolute_lifetime() {
        let day = Duration::from_secs(24 * 3600);
        assert_eq!(initial_expiry_ms(1000, day), 1000 + 86_400_000);
        assert_eq!(
            initial_expiry_ms(0, day * 60),
            duration_ms(ABSOLUTE_LIFETIME)
        );
        // Sliding forward late in a session still respects the cap from login.
        let cap = duration_ms(ABSOLUTE_LIFETIME);
        assert_eq!(expiry_ms(0, cap - 1000, day), cap);
    }

    #[test]
    fn cookie_attributes_follow_the_secure_setting() {
        let secure = set_cookie_header(true, "tok");
        assert!(secure.starts_with("__Host-songbird_session=tok;"));
        for attribute in ["HttpOnly", "SameSite=Lax", "Path=/", "; Secure"] {
            assert!(secure.contains(attribute), "{secure}");
        }
        assert!(!secure.contains("Domain"));

        let plain = set_cookie_header(false, "tok");
        assert!(plain.starts_with("songbird_session=tok;"));
        assert!(!plain.contains("Secure"));

        let cleared = clear_cookie_header(true);
        for attribute in [
            "__Host-songbird_session=;",
            "HttpOnly",
            "SameSite=Lax",
            "Path=/",
            "Secure",
            "Max-Age=0",
            "1970",
        ] {
            assert!(cleared.contains(attribute), "{cleared}");
        }
    }
}
