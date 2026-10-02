use std::str::FromStr;

use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::Row;

use super::*;

fn sqlite_url(dir: &tempfile::TempDir) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("a/b/t.db").display()
    )
}

#[tokio::test]
async fn sqlite_file_and_missing_directories_are_created() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::connect(&DatabaseConfig::with_url(sqlite_url(&dir)))
        .await
        .unwrap();
    assert_eq!(db.backend(), Backend::Sqlite);
    assert!(dir.path().join("a/b/t.db").exists());
}

#[tokio::test]
async fn every_pooled_sqlite_connection_has_the_safety_pragmas() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = DatabaseConfig::with_url(sqlite_url(&dir));
    config.max_connections = 3;
    let db = Db::connect(&config).await.unwrap();

    // Held at once so the pool must open distinct connections, not reuse one.
    let mut conns = Vec::new();
    for _ in 0..3 {
        conns.push(db.pool().acquire().await.unwrap());
    }
    for conn in &mut conns {
        for (pragma, expected) in [
            ("foreign_keys", "1"),
            ("journal_mode", "wal"),
            ("busy_timeout", "5000"),
            ("synchronous", "1"),
        ] {
            let row = sqlx::query(&format!("PRAGMA {pragma}"))
                .fetch_one(&mut **conn)
                .await
                .unwrap();
            let value = row
                .try_get::<String, _>(0)
                .unwrap_or_else(|_| row.get::<i64, _>(0).to_string());
            assert_eq!(value, expected, "PRAGMA {pragma}");
        }
    }
}

#[tokio::test]
async fn sqlite_enforces_foreign_keys() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::connect(&DatabaseConfig::with_url(sqlite_url(&dir)))
        .await
        .unwrap();
    sqlx::query("CREATE TABLE parent (id TEXT PRIMARY KEY)")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("CREATE TABLE child (parent_id TEXT NOT NULL REFERENCES parent(id))")
        .execute(db.pool())
        .await
        .unwrap();
    let orphan = sqlx::query("INSERT INTO child (parent_id) VALUES ($1)")
        .bind("missing")
        .execute(db.pool())
        .await;
    assert!(orphan.is_err());
}

#[tokio::test]
async fn in_memory_and_unknown_schemes_fail_before_connecting() {
    for url in ["sqlite::memory:", "mysql://u:p@h/d"] {
        let err = Db::connect(&DatabaseConfig::with_url(url))
            .await
            .unwrap_err();
        assert!(err.to_string().contains(DATABASE_URL), "{err}");
    }
}

#[test]
fn postgres_tls_parameters_reach_the_driver() {
    let url = "postgres://u:p@db/songbird?sslmode=verify-full&sslrootcert=/etc/ca.pem";
    assert!(Target::parse(Some(&SecretString::from(url.to_string()))).is_ok());
    let options = PgConnectOptions::from_str(url).unwrap();
    assert!(matches!(options.get_ssl_mode(), PgSslMode::VerifyFull));
}

#[tokio::test]
async fn connect_failure_never_shows_the_password() {
    let err = Db::connect(&DatabaseConfig::with_url(
        "postgres://songbird:s3cret@127.0.0.1:1/songbird",
    ))
    .await
    .unwrap_err()
    .to_string();
    assert!(!err.contains("s3cret"), "{err}");
    assert!(err.contains("127.0.0.1:1/songbird"), "{err}");
}
