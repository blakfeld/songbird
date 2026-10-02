//! Runs on whichever backend `test_db()` selects, so a Postgres pass covers
//! the same assertions.

mod common;

use api::auth::session::{hash_token, SECURE_COOKIE_NAME};
use api::db::Db;
use api::users::{self, UserError};
use common::db::test_db;
use common::session::{login_as, seed_user};
use sqlx::Row;

async fn count(db: &Db, table: &str) -> i64 {
    sqlx::query(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get::<i64, _>(0)
}

async fn insert_project(db: &Db, owner_id: &str, id: &str) {
    sqlx::query(
        "INSERT INTO projects (id, owner_id, name, time_signature, track_count, song, size_bytes, revision, created_at, updated_at) \
         VALUES ($1, $2, 'Demo', '4/4', 1, '{}', 2, 1, 0, 0)",
    )
    .bind(id)
    .bind(owner_id)
    .execute(db.pool())
    .await
    .unwrap();
}

async fn insert_usage(db: &Db, user_id: &str) {
    sqlx::query("INSERT INTO ai_usage (user_id, day, count) VALUES ($1, 20000, 3)")
        .bind(user_id)
        .execute(db.pool())
        .await
        .unwrap();
}

#[tokio::test]
async fn create_stores_a_trimmed_lowercased_email() {
    let db = test_db().await;
    let user = users::create(&db, "  Ana@Example.COM ", "hash")
        .await
        .unwrap();
    assert_eq!(user.email, "ana@example.com");
    assert!(!user.disabled);

    let found = users::find_by_email(&db, "ANA@example.com")
        .await
        .unwrap()
        .expect("found regardless of case");
    assert_eq!(found, user);
}

#[tokio::test]
async fn duplicate_email_differing_only_in_case_is_refused() {
    let db = test_db().await;
    users::create(&db, "ana@example.com", "hash").await.unwrap();
    let err = users::create(&db, "Ana@Example.com", "hash")
        .await
        .unwrap_err();
    assert!(matches!(err, UserError::EmailInUse), "{err:?}");
    assert_eq!(count(&db, "users").await, 1);
}

#[tokio::test]
async fn find_missing_user_is_none() {
    let db = test_db().await;
    assert!(users::find_by_email(&db, "nobody@example.com")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn set_password_replaces_the_hash_and_ends_sessions_of_that_user_only() {
    let db = test_db().await;
    let ana = seed_user(&db, "ana@example.com").await;
    login_as(&db, "ana@example.com").await;
    login_as(&db, "bo@example.com").await;
    assert_eq!(count(&db, "sessions").await, 2);

    users::set_password(&db, "ANA@example.com", "new-hash")
        .await
        .unwrap();

    let updated = users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.password_hash, "new-hash");
    assert!(updated.updated_at >= ana.updated_at);
    assert_eq!(count(&db, "sessions").await, 1);
}

#[tokio::test]
async fn disable_ends_sessions_and_enable_keeps_the_account() {
    let db = test_db().await;
    seed_user(&db, "ana@example.com").await;
    login_as(&db, "ana@example.com").await;

    users::set_disabled(&db, "ana@example.com", true)
        .await
        .unwrap();
    let disabled = users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    assert!(disabled.disabled);
    assert_eq!(count(&db, "sessions").await, 0);

    users::set_disabled(&db, "ana@example.com", false)
        .await
        .unwrap();
    let enabled = users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    assert!(!enabled.disabled);
}

#[tokio::test]
async fn changes_to_a_missing_user_report_not_found() {
    let db = test_db().await;
    for result in [
        users::set_password(&db, "x@example.com", "h").await,
        users::set_disabled(&db, "x@example.com", true).await,
        users::delete(&db, "x@example.com").await,
    ] {
        assert!(matches!(result, Err(UserError::NotFound)), "{result:?}");
    }
}

#[tokio::test]
async fn delete_removes_the_users_projects_sessions_and_usage_but_nobody_elses() {
    let db = test_db().await;
    let ana = seed_user(&db, "ana@example.com").await;
    let bo = seed_user(&db, "bo@example.com").await;
    login_as(&db, "ana@example.com").await;
    login_as(&db, "bo@example.com").await;
    insert_project(&db, &ana.id, "p-ana").await;
    insert_project(&db, &bo.id, "p-bo").await;
    insert_usage(&db, &ana.id).await;
    insert_usage(&db, &bo.id).await;

    users::delete(&db, "Ana@example.com").await.unwrap();

    assert_eq!(count(&db, "users").await, 1);
    assert_eq!(count(&db, "projects").await, 1);
    assert_eq!(count(&db, "sessions").await, 1);
    assert_eq!(count(&db, "ai_usage").await, 1);
    let remaining: String = sqlx::query("SELECT owner_id FROM projects")
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get(0);
    assert_eq!(remaining, bo.id);
}

#[tokio::test]
async fn list_is_ordered_by_email_and_includes_disabled_accounts() {
    let db = test_db().await;
    seed_user(&db, "bo@example.com").await;
    seed_user(&db, "ana@example.com").await;
    users::set_disabled(&db, "bo@example.com", true)
        .await
        .unwrap();

    let all = users::list(&db).await.unwrap();
    let summary: Vec<_> = all.iter().map(|u| (u.email.as_str(), u.disabled)).collect();
    assert_eq!(
        summary,
        [("ana@example.com", false), ("bo@example.com", true)]
    );
}

#[tokio::test]
async fn login_as_seeds_a_user_and_a_session_and_stores_only_the_token_hash() {
    let db = test_db().await;
    let cookie = login_as(&db, "ana@example.com").await;

    let token = cookie
        .strip_prefix(&format!("{SECURE_COOKIE_NAME}="))
        .expect("cookie uses the secure session name");
    assert_eq!(count(&db, "users").await, 1);
    assert_eq!(count(&db, "sessions").await, 1);

    let row = sqlx::query("SELECT token_hash, created_at, expires_at FROM sessions")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("token_hash"), hash_token(token));
    assert_ne!(row.get::<String, _>("token_hash"), token);
    assert!(row.get::<i64, _>("expires_at") > row.get::<i64, _>("created_at"));

    login_as(&db, "ana@example.com").await;
    assert_eq!(count(&db, "users").await, 1, "reuses the existing user");
    assert_eq!(count(&db, "sessions").await, 2);
}
