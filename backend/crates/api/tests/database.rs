//! Behavior that must hold on both backends runs through `test_db()`; checks
//! that need a Postgres server skip themselves when none is configured.

mod common;

use api::config::{Config, AI_PROVIDER, DATABASE_URL};
use api::db::{Backend, DatabaseConfig, Db, POSTGRES_MIGRATIONS, SQLITE_MIGRATIONS};
use api::startup::build_state;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::db::{postgres_url, test_db};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::Row;
use tower::ServiceExt;

fn config_with_database(url: &str) -> Config {
    Config::from_lookup(|k| match k {
        AI_PROVIDER => Some("mock".to_string()),
        DATABASE_URL => Some(url.to_string()),
        _ => None,
    })
    .unwrap()
}

async fn get(app: axum::Router, uri: &str) -> (StatusCode, Value) {
    let res = app
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn app_over(db: common::db::TestDb) -> axum::Router {
    let config = Config::from_lookup(|k| (k == AI_PROVIDER).then(|| "mock".to_string())).unwrap();
    let state = api::state::AppState {
        providers: api::provider::Providers::mock(),
        instruments: music::InstrumentRegistry::builtin(),
        config: std::sync::Arc::new(config),
        db: (*db).clone(),
    };
    db.keep_alive_with(api::app(state))
}

#[tokio::test]
async fn startup_creates_the_sqlite_file_in_a_fresh_directory() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("data/songbird.db");
    let url = format!("sqlite://{}?mode=rwc", file.display());

    let state = build_state(config_with_database(&url)).await.unwrap();

    assert!(file.exists());
    assert_eq!(state.db.backend(), Backend::Sqlite);
    let applied: i64 = sqlx::query("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(state.db.pool())
        .await
        .unwrap()
        .get(0);
    assert_eq!(applied as usize, SQLITE_MIGRATIONS.migrations.len());
}

#[tokio::test]
async fn restarting_does_not_reapply_migrations() {
    let db = test_db().await;
    let before: i64 = sqlx::query("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get(0);
    // Same database, so this is a second startup against an already-migrated one.
    let again = Db::connect(&DatabaseConfig::with_url(db.url()))
        .await
        .unwrap();
    let after: i64 = sqlx::query("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(again.pool())
        .await
        .unwrap()
        .get(0);
    assert_eq!(before, after);
}

#[tokio::test]
async fn a_database_from_a_newer_build_fails_startup_naming_the_version() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}?mode=rwc", dir.path().join("t.db").display());
    let db = Db::connect(&DatabaseConfig::with_url(&url)).await.unwrap();
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (9999, 'from the future', 1, x'00', 0)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    db.pool().close().await;

    let err = build_state(config_with_database(&url)).await.err().unwrap();

    assert!(err.contains("9999"), "{err}");
}

#[tokio::test]
async fn unreachable_postgres_fails_startup_without_leaking_the_password() {
    let err = build_state(config_with_database(
        "postgres://songbird:s3cret@127.0.0.1:1/songbird",
    ))
    .await
    .err()
    .unwrap();
    assert!(!err.contains("s3cret"), "{err}");
}

#[tokio::test]
async fn wrong_postgres_password_fails_without_leaking_it() {
    let Some(url) = postgres_url() else {
        return;
    };
    let mut bad = url::Url::parse(&url).unwrap();
    bad.set_password(Some("s3cret-wrong")).unwrap();
    let err = Db::connect(&DatabaseConfig::with_url(bad.as_str()))
        .await
        .unwrap_err()
        .to_string();
    assert!(!err.contains("s3cret-wrong"), "{err}");
    assert!(
        err.contains(bad.host_str().unwrap()),
        "message should still say where it failed: {err}"
    );
}

#[tokio::test]
async fn readyz_is_ready_with_a_working_database() {
    let app = app_over(test_db().await).await;
    let (status, body) = get(app, "/readyz").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status": "ready"}));
}

#[tokio::test]
async fn readyz_is_503_when_the_pool_is_closed_but_healthz_stays_up() {
    let db = test_db().await;
    db.pool().close().await;
    let app = app_over(db).await;

    let (status, body) = get(app.clone(), "/readyz").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "not_ready");

    let (status, body) = get(app, "/healthz").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status": "ok"}));
}

/// sqlx binds positionally and SQLite reads `$1` as a named parameter, so an
/// upgrade that changed either would silently break every portable query.
#[tokio::test]
async fn dollar_placeholders_bind_by_position() {
    let db = test_db().await;
    sqlx::query("CREATE TABLE binding (a TEXT NOT NULL, b BIGINT NOT NULL)")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO binding (a, b) VALUES ($1, $2)")
        .bind("first")
        .bind(42_i64)
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO binding (a, b) VALUES ($1, $2)")
        .bind("second")
        .bind(7_i64)
        .execute(db.pool())
        .await
        .unwrap();

    let row = sqlx::query("SELECT a, b FROM binding WHERE b = $2 AND a = $1")
        .bind("first")
        .bind(42_i64)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>(0), "first");
    assert_eq!(row.get::<i64, _>(1), 42);

    let reused: i64 = sqlx::query("SELECT COUNT(*) FROM binding WHERE a = $1 OR a = $1")
        .bind("second")
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get(0);
    assert_eq!(reused, 1);
}

#[tokio::test]
async fn each_test_db_is_isolated_and_migrated() {
    let (first, second) = (test_db().await, test_db().await);
    sqlx::query("CREATE TABLE only_in_first (id TEXT)")
        .execute(first.pool())
        .await
        .unwrap();
    assert!(sqlx::query("SELECT * FROM only_in_first")
        .fetch_all(second.pool())
        .await
        .is_err());
    for db in [&first, &second] {
        assert!(sqlx::query("SELECT version FROM _sqlx_migrations")
            .fetch_all(db.pool())
            .await
            .is_ok());
    }
}

async fn sqlite_columns(db: &Db) -> Vec<(String, String)> {
    sqlx::query(
        "SELECT m.name, p.name FROM sqlite_master m, pragma_table_info(m.name) p \
         WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name <> '_sqlx_migrations' \
         ORDER BY m.name, p.name",
    )
    .fetch_all(db.pool())
    .await
    .unwrap()
    .iter()
    .map(|r| (r.get(0), r.get(1)))
    .collect()
}

async fn postgres_columns(db: &Db) -> Vec<(String, String)> {
    sqlx::query(
        "SELECT table_name::text, column_name::text FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name <> '_sqlx_migrations' \
         ORDER BY table_name, column_name",
    )
    .fetch_all(db.pool())
    .await
    .unwrap()
    .iter()
    .map(|r| (r.get(0), r.get(1)))
    .collect()
}

#[tokio::test]
async fn both_migration_sets_produce_the_same_tables_and_columns() {
    let sqlite = common::db::sqlite_test_db().await;
    let sqlite_columns = sqlite_columns(&sqlite).await;

    let Some(postgres) = common::db::postgres_test_db_if_configured().await else {
        return;
    };
    assert_eq!(sqlite_columns, postgres_columns(&postgres).await);
    assert_eq!(
        SQLITE_MIGRATIONS.migrations.len(),
        POSTGRES_MIGRATIONS.migrations.len()
    );
}

/// Holding the pool's only connection makes the probe wait for one, so this
/// exercises the 2 s timeout rather than a fast error. Real time, not paused.
#[tokio::test]
async fn readyz_is_503_within_the_timeout_when_the_database_never_answers() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}?mode=rwc", dir.path().join("t.db").display());
    let mut config = DatabaseConfig::with_url(url);
    config.max_connections = 1;
    let db = Db::connect(&config).await.unwrap();
    let _held = db.pool().acquire().await.unwrap();
    let app_config =
        Config::from_lookup(|k| (k == AI_PROVIDER).then(|| "mock".to_string())).unwrap();
    let app = api::app(api::state::AppState {
        providers: api::provider::Providers::mock(),
        instruments: music::InstrumentRegistry::builtin(),
        config: std::sync::Arc::new(app_config),
        db: db.clone(),
    });

    let started = std::time::Instant::now();
    let (status, body) = get(app, "/readyz").await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "not_ready");
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert!(started.elapsed() >= std::time::Duration::from_millis(1500));
}
