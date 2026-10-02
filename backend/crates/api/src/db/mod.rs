//! One pool type for both backends so query code is written once; see `README.md`
//! for the SQL conventions that make that safe.

mod migrate;
mod target;
#[cfg(test)]
mod tests;

use std::time::Duration;

use secrecy::{ExposeSecret, SecretString};
use sqlx::any::{install_default_drivers, AnyPoolOptions};
use sqlx::AnyPool;

pub use migrate::{migrator, POSTGRES as POSTGRES_MIGRATIONS, SQLITE as SQLITE_MIGRATIONS};
pub use target::{Backend, DEFAULT_URL};

use crate::config::DATABASE_URL;
use target::Target;

/// Bounds how long startup waits on an unreachable server instead of sqlx's 30 s default.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// `Debug` is safe to log: the URL is a `SecretString`.
#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    pub url: Option<SecretString>,
    pub max_connections: u32,
}

impl DatabaseConfig {
    pub fn with_url(url: impl Into<String>) -> Self {
        Self {
            url: Some(SecretString::from(url.into())),
            max_connections: 10,
        }
    }
}

/// Messages here reach logs, so they carry only a redacted URL.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(
        "{} uses unsupported scheme \"{scheme}\"; use sqlite:, postgres:, or postgresql:",
        DATABASE_URL
    )]
    UnsupportedScheme { scheme: String },
    #[error(
        "{} is an in-memory SQLite database, which would be a different empty database on every pooled connection; use a file path",
        DATABASE_URL
    )]
    InMemorySqlite,
    #[error("{} is not a valid Postgres URL", DATABASE_URL)]
    InvalidUrl,
    #[error("cannot create the SQLite directory {path}: {source}")]
    CreateDirectory {
        path: String,
        source: std::io::Error,
    },
    #[error("cannot connect to the database at {url}: {reason}")]
    Connect { url: String, reason: String },
    #[error("database migration failed for {url}: {reason}")]
    Migrate { url: String, reason: String },
}

#[derive(Debug, Clone)]
pub struct Db {
    pool: AnyPool,
    backend: Backend,
}

impl Db {
    /// Migrating here rather than in `main` so tests and the service share one path
    /// and no caller can serve requests against an unmigrated database.
    pub async fn connect(config: &DatabaseConfig) -> Result<Self, DbError> {
        let target = Target::parse(config.url.as_ref())?;
        install_default_drivers();

        if let Some(parent) = target
            .sqlite_path
            .as_deref()
            .and_then(|p| p.parent())
            .filter(|p| !p.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|source| DbError::CreateDirectory {
                path: parent.display().to_string(),
                source,
            })?;
        }

        let mut options = AnyPoolOptions::new()
            .max_connections(config.max_connections)
            .acquire_timeout(CONNECT_TIMEOUT);
        if target.backend == Backend::Sqlite {
            // `Any` connect options cannot carry SQLite settings, and these must hold on
            // every pooled connection, not just the first.
            options = options.after_connect(|conn, _meta| {
                Box::pin(async move {
                    for pragma in [
                        "PRAGMA foreign_keys = ON",
                        "PRAGMA journal_mode = WAL",
                        "PRAGMA busy_timeout = 5000",
                        "PRAGMA synchronous = NORMAL",
                    ] {
                        sqlx::query(pragma).execute(&mut *conn).await?;
                    }
                    Ok(())
                })
            });
        }

        let pool = options
            .connect(target.url.expose_secret())
            .await
            .map_err(|e| DbError::Connect {
                url: target.redacted.clone(),
                reason: target.scrub(&e.to_string()),
            })?;

        migrator(target.backend)
            .run(&pool)
            .await
            .map_err(|e| DbError::Migrate {
                url: target.redacted.clone(),
                reason: target.scrub(&e.to_string()),
            })?;

        Ok(Self {
            pool,
            backend: target.backend,
        })
    }

    pub fn pool(&self) -> &AnyPool {
        &self.pool
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }
}
