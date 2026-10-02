//! Per-test migrated databases. SQLite by default so tests need no server;
//! Postgres when `SONGBIRD_TEST_POSTGRES_URL` is set. `sqlx::test` is avoided
//! because it is tied to one concrete driver and does not fit `Any`.

use std::ops::Deref;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use api::db::{Backend, DatabaseConfig, Db};
use axum::extract::Request;
use axum::middleware::Next;
use axum::Router;
use sqlx::any::{install_default_drivers, AnyPoolOptions};
use sqlx::Executor;
use tempfile::TempDir;
use tokio::sync::OnceCell;

pub const POSTGRES_URL_VAR: &str = "SONGBIRD_TEST_POSTGRES_URL";
const DB_PREFIX: &str = "songbird_test_";
const STALE_AFTER_SECS: u64 = 60 * 60;

static SWEEP: OnceCell<()> = OnceCell::const_new();

pub struct TestDb {
    db: Db,
    url: String,
    cleanup: Cleanup,
}

enum Cleanup {
    TempDir(#[allow(dead_code)] TempDir),
    // Held by name so Drop can issue the DROP from a fresh connection.
    Postgres { admin_url: String, name: String },
}

impl Deref for TestDb {
    type Target = Db;

    fn deref(&self) -> &Db {
        &self.db
    }
}

impl TestDb {
    /// Lets a test open a second connection to the same database, as a restart would.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Test helpers build a router and return it, so the database must live as
    /// long as the router's requests. A request extension would not do: it is
    /// dropped as soon as the handler's extractors consume the request, which
    /// can be before the handler touches the database.
    pub fn keep_alive_with(self, router: Router) -> Router {
        let guard = Arc::new(self);
        router.layer(axum::middleware::from_fn(
            move |req: Request, next: Next| {
                let guard = guard.clone();
                async move {
                    let response = next.run(req).await;
                    drop(guard);
                    response
                }
            },
        ))
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let Cleanup::Postgres { admin_url, name } = &self.cleanup else {
            return;
        };
        let (admin_url, name) = (admin_url.clone(), name.clone());
        // A fresh thread and runtime because Drop may run on a runtime worker
        // that must not block, or after the test's runtime is gone.
        let _ = std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            runtime.block_on(async {
                if let Ok(admin) = admin_pool(&admin_url).await {
                    let _ = admin
                        .execute(format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)").as_str())
                        .await;
                }
            });
        })
        .join();
    }
}

pub fn postgres_url() -> Option<String> {
    std::env::var(POSTGRES_URL_VAR)
        .ok()
        .filter(|u| !u.trim().is_empty())
}

pub async fn postgres_test_db_if_configured() -> Option<TestDb> {
    match postgres_url() {
        Some(url) => Some(postgres_test_db(&url).await),
        None => None,
    }
}

pub async fn test_db() -> TestDb {
    match postgres_url() {
        Some(url) => postgres_test_db(&url).await,
        None => sqlite_test_db().await,
    }
}

pub async fn sqlite_test_db() -> TestDb {
    let dir = TempDir::new().expect("temp dir");
    let url = format!("sqlite://{}?mode=rwc", dir.path().join("test.db").display());
    let db = Db::connect(&DatabaseConfig::with_url(url.clone()))
        .await
        .expect("sqlite test database");
    TestDb {
        db,
        url,
        cleanup: Cleanup::TempDir(dir),
    }
}

async fn postgres_test_db(admin_url: &str) -> TestDb {
    SWEEP
        .get_or_init(|| async { sweep_stale(admin_url).await })
        .await;

    // The creation time in the name lets a later run tell which leftovers are stale.
    let name = format!(
        "{DB_PREFIX}{}_{}",
        unix_secs(),
        uuid::Uuid::now_v7().simple()
    );
    let admin = admin_pool(admin_url).await.expect("postgres admin pool");
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .expect("create test database");
    admin.close().await;

    let mut url = url::Url::parse(admin_url).expect("SONGBIRD_TEST_POSTGRES_URL is a URL");
    url.set_path(&name);
    let url = url.to_string();
    let db = Db::connect(&DatabaseConfig::with_url(url.clone()))
        .await
        .expect("postgres test database");
    assert_eq!(db.backend(), Backend::Postgres);
    TestDb {
        db,
        url,
        cleanup: Cleanup::Postgres {
            admin_url: admin_url.to_string(),
            name,
        },
    }
}

async fn admin_pool(url: &str) -> Result<sqlx::AnyPool, sqlx::Error> {
    install_default_drivers();
    AnyPoolOptions::new().max_connections(1).connect(url).await
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs()
}

/// Cleans up after runs that were killed before `Drop` could.
async fn sweep_stale(admin_url: &str) {
    let Ok(admin) = admin_pool(admin_url).await else {
        return;
    };
    let rows = sqlx::query(
        "SELECT datname::text FROM pg_database WHERE datname LIKE 'songbird\\_test\\_%'",
    )
    .fetch_all(&admin)
    .await
    .unwrap_or_default();
    for row in rows {
        let name: String = sqlx::Row::get(&row, 0);
        let created = name
            .strip_prefix(DB_PREFIX)
            .and_then(|rest| rest.split('_').next())
            .and_then(|secs| secs.parse::<u64>().ok());
        if created.is_some_and(|c| unix_secs().saturating_sub(c) > STALE_AFTER_SECS) {
            let _ = admin
                .execute(format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)").as_str())
                .await;
        }
    }
    admin.close().await;
}
