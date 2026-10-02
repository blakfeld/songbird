//! A login verifies a password, which takes tens of milliseconds, and only then
//! creates its session. These tests replay an operator action landing in
//! between by calling the conditional steps directly in that order.

mod common;

use std::time::Duration;

use api::auth::session::create_if_credentials_unchanged;
use api::clock::now_ms;
use api::users;
use common::db::test_db;
use sqlx::Row;

const IDLE: Duration = Duration::from_secs(3600);

async fn session_count(db: &api::db::Db) -> i64 {
    sqlx::query("SELECT COUNT(*) FROM sessions")
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get(0)
}

#[tokio::test]
async fn a_session_is_created_when_the_verified_hash_is_still_current() {
    let db = test_db().await;
    let user = users::create(&db, "ana@example.com", "hash-1")
        .await
        .unwrap();

    let token = create_if_credentials_unchanged(&db, &user.id, "hash-1", now_ms(), IDLE)
        .await
        .unwrap();

    assert!(token.is_some());
    assert_eq!(session_count(&db).await, 1);
}

#[tokio::test]
async fn set_password_between_verify_and_create_leaves_no_session() {
    let db = test_db().await;
    let user = users::create(&db, "ana@example.com", "hash-1")
        .await
        .unwrap();

    users::set_password(&db, "ana@example.com", "hash-2")
        .await
        .unwrap();
    let token = create_if_credentials_unchanged(&db, &user.id, "hash-1", now_ms(), IDLE)
        .await
        .unwrap();

    assert!(token.is_none());
    assert_eq!(session_count(&db).await, 0);
}

#[tokio::test]
async fn disabling_between_verify_and_create_leaves_no_session() {
    let db = test_db().await;
    let user = users::create(&db, "ana@example.com", "hash-1")
        .await
        .unwrap();

    users::set_disabled(&db, "ana@example.com", true)
        .await
        .unwrap();
    let token = create_if_credentials_unchanged(&db, &user.id, "hash-1", now_ms(), IDLE)
        .await
        .unwrap();

    assert!(token.is_none());
    assert_eq!(session_count(&db).await, 0);
}

#[tokio::test]
async fn a_rehash_does_not_overwrite_a_concurrent_password_reset() {
    let db = test_db().await;
    let user = users::create(&db, "ana@example.com", "hash-1")
        .await
        .unwrap();

    users::set_password(&db, "ana@example.com", "hash-2")
        .await
        .unwrap();
    let replaced = users::replace_hash_if(&db, &user.id, "hash-1", "hash-1-upgraded")
        .await
        .unwrap();

    assert!(!replaced);
    let stored = users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.password_hash, "hash-2");
}

#[tokio::test]
async fn an_upgraded_hash_is_what_the_session_check_compares_against() {
    let db = test_db().await;
    let user = users::create(&db, "ana@example.com", "hash-1")
        .await
        .unwrap();

    assert!(
        users::replace_hash_if(&db, &user.id, "hash-1", "hash-1-upgraded")
            .await
            .unwrap()
    );

    let stale = create_if_credentials_unchanged(&db, &user.id, "hash-1", now_ms(), IDLE)
        .await
        .unwrap();
    let current = create_if_credentials_unchanged(&db, &user.id, "hash-1-upgraded", now_ms(), IDLE)
        .await
        .unwrap();
    assert!(stale.is_none());
    assert!(current.is_some());
}
