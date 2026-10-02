//! Storage rules for users' provider keys. Each test runs on SQLite and, when
//! `SONGBIRD_TEST_POSTGRES_URL` is set, on Postgres as well.

mod common;

use std::future::Future;

use api::db::Db;
use api::keys::{self, AiProvider, EncryptedKey, KeyStoreError};
use api::users;
use common::db::{postgres_test_db_if_configured, sqlite_test_db};
use common::session::seed_user;
use sqlx::Row;

async fn on_every_backend<F, Fut>(test: F)
where
    F: Fn(Db) -> Fut,
    Fut: Future<Output = ()>,
{
    let sqlite = sqlite_test_db().await;
    test((*sqlite).clone()).await;
    if let Some(postgres) = postgres_test_db_if_configured().await {
        test((*postgres).clone()).await;
        drop(postgres);
    }
    drop(sqlite);
}

fn sealed(tag: &str) -> EncryptedKey {
    EncryptedKey {
        key_version: "v1".into(),
        nonce: format!("nonce-{tag}"),
        ciphertext: format!("cipher-{tag}"),
    }
}

async fn save(db: &Db, user_id: &str, provider: AiProvider, tag: &str) {
    keys::upsert(db, user_id, provider, &sealed(tag), tag)
        .await
        .unwrap();
}

async fn count(db: &Db, table: &str) -> i64 {
    sqlx::query(&format!("SELECT CAST(COUNT(*) AS BIGINT) FROM {table}"))
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get(0)
}

#[tokio::test]
async fn a_new_user_has_no_keys_and_no_active_provider() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        let summary = keys::summary(&db, &ana.id).await.unwrap();
        assert!(summary.keys.is_empty());
        assert_eq!(summary.active_provider, None);
        assert!(keys::active_key(&db, &ana.id).await.unwrap().is_none());
    })
    .await;
}

#[tokio::test]
async fn the_first_key_becomes_active_and_a_second_does_not_take_over() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        save(&db, &ana.id, AiProvider::Openai, "oa11").await;
        let summary = keys::summary(&db, &ana.id).await.unwrap();
        assert_eq!(summary.active_provider, Some(AiProvider::Openai));

        save(&db, &ana.id, AiProvider::Anthropic, "an22").await;
        let summary = keys::summary(&db, &ana.id).await.unwrap();
        let listed: Vec<_> = summary
            .keys
            .iter()
            .map(|k| (k.provider, k.last4.as_str()))
            .collect();
        assert_eq!(
            listed,
            [
                (AiProvider::Anthropic, "an22"),
                (AiProvider::Openai, "oa11")
            ]
        );
        assert_eq!(summary.active_provider, Some(AiProvider::Openai));

        let active = keys::active_key(&db, &ana.id).await.unwrap().unwrap();
        assert_eq!(active.provider, AiProvider::Openai);
        assert_eq!(active.encrypted, sealed("oa11"));
    })
    .await;
}

#[tokio::test]
async fn replacing_a_key_overwrites_it_and_keeps_the_active_choice() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        save(&db, &ana.id, AiProvider::Anthropic, "old1").await;
        let before = keys::summary(&db, &ana.id).await.unwrap();
        save(&db, &ana.id, AiProvider::Anthropic, "new2").await;
        let after = keys::summary(&db, &ana.id).await.unwrap();

        assert_eq!(after.keys.len(), 1);
        assert_eq!(after.keys[0].last4, "new2");
        assert!(after.keys[0].updated_at >= before.keys[0].updated_at);
        assert_eq!(after.active_provider, Some(AiProvider::Anthropic));
        let active = keys::active_key(&db, &ana.id).await.unwrap().unwrap();
        assert_eq!(active.encrypted, sealed("new2"));
    })
    .await;
}

#[tokio::test]
async fn set_active_switches_between_stored_keys_only() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        save(&db, &ana.id, AiProvider::Anthropic, "an11").await;

        let err = keys::set_active(&db, &ana.id, AiProvider::Openai)
            .await
            .unwrap_err();
        assert!(matches!(err, KeyStoreError::NoKeyForProvider));
        assert_eq!(
            keys::summary(&db, &ana.id).await.unwrap().active_provider,
            Some(AiProvider::Anthropic)
        );

        save(&db, &ana.id, AiProvider::Openai, "oa22").await;
        keys::set_active(&db, &ana.id, AiProvider::Openai)
            .await
            .unwrap();
        assert_eq!(
            keys::summary(&db, &ana.id).await.unwrap().active_provider,
            Some(AiProvider::Openai)
        );
        keys::set_active(&db, &ana.id, AiProvider::Anthropic)
            .await
            .unwrap();
        assert_eq!(
            keys::summary(&db, &ana.id).await.unwrap().active_provider,
            Some(AiProvider::Anthropic)
        );
    })
    .await;
}

#[tokio::test]
async fn setting_the_provider_of_a_user_without_keys_fails() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        let err = keys::set_active(&db, &ana.id, AiProvider::Anthropic)
            .await
            .unwrap_err();
        assert!(matches!(err, KeyStoreError::NoKeyForProvider));
        assert_eq!(count(&db, "user_ai_settings").await, 0);
    })
    .await;
}

#[tokio::test]
async fn removing_the_active_key_falls_back_to_the_other_or_to_none() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        save(&db, &ana.id, AiProvider::Anthropic, "an11").await;
        save(&db, &ana.id, AiProvider::Openai, "oa22").await;

        keys::delete(&db, &ana.id, AiProvider::Anthropic)
            .await
            .unwrap();
        let summary = keys::summary(&db, &ana.id).await.unwrap();
        assert_eq!(summary.active_provider, Some(AiProvider::Openai));
        assert_eq!(summary.keys.len(), 1);

        keys::delete(&db, &ana.id, AiProvider::Openai)
            .await
            .unwrap();
        let summary = keys::summary(&db, &ana.id).await.unwrap();
        assert!(summary.keys.is_empty());
        assert_eq!(summary.active_provider, None);
        assert!(keys::active_key(&db, &ana.id).await.unwrap().is_none());

        // Guards against the active choice staying NULL forever once it has been cleared.
        save(&db, &ana.id, AiProvider::Anthropic, "an33").await;
        assert_eq!(
            keys::summary(&db, &ana.id).await.unwrap().active_provider,
            Some(AiProvider::Anthropic)
        );
    })
    .await;
}

#[tokio::test]
async fn removing_the_inactive_key_keeps_the_active_choice() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        save(&db, &ana.id, AiProvider::Anthropic, "an11").await;
        save(&db, &ana.id, AiProvider::Openai, "oa22").await;

        keys::delete(&db, &ana.id, AiProvider::Openai)
            .await
            .unwrap();
        assert_eq!(
            keys::summary(&db, &ana.id).await.unwrap().active_provider,
            Some(AiProvider::Anthropic)
        );
    })
    .await;
}

#[tokio::test]
async fn removing_a_missing_key_is_a_no_op() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        keys::delete(&db, &ana.id, AiProvider::Anthropic)
            .await
            .unwrap();
        save(&db, &ana.id, AiProvider::Openai, "oa11").await;
        keys::delete(&db, &ana.id, AiProvider::Anthropic)
            .await
            .unwrap();
        let summary = keys::summary(&db, &ana.id).await.unwrap();
        assert_eq!(summary.keys.len(), 1);
        assert_eq!(summary.active_provider, Some(AiProvider::Openai));
    })
    .await;
}

#[tokio::test]
async fn users_never_see_or_change_each_others_keys() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        let bo = seed_user(&db, "bo@example.com").await;
        save(&db, &ana.id, AiProvider::Anthropic, "ana1").await;
        save(&db, &bo.id, AiProvider::Openai, "bo22").await;

        assert_eq!(keys::summary(&db, &ana.id).await.unwrap().keys.len(), 1);
        let bo_summary = keys::summary(&db, &bo.id).await.unwrap();
        assert_eq!(bo_summary.keys[0].last4, "bo22");
        assert_eq!(bo_summary.active_provider, Some(AiProvider::Openai));

        keys::delete(&db, &bo.id, AiProvider::Anthropic)
            .await
            .unwrap();
        assert!(matches!(
            keys::set_active(&db, &bo.id, AiProvider::Anthropic).await,
            Err(KeyStoreError::NoKeyForProvider)
        ));
        let ana_summary = keys::summary(&db, &ana.id).await.unwrap();
        assert_eq!(ana_summary.keys.len(), 1);
        assert_eq!(ana_summary.active_provider, Some(AiProvider::Anthropic));
    })
    .await;
}

#[tokio::test]
async fn stored_rows_hold_only_the_sealed_text_and_the_last_four() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        save(&db, &ana.id, AiProvider::Anthropic, "abcd").await;
        let row = sqlx::query(
            "SELECT key_version, nonce, ciphertext, last4 FROM user_api_keys WHERE user_id = $1",
        )
        .bind(&ana.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
        let columns: Vec<String> = (0..4).map(|i| row.get(i)).collect();
        assert_eq!(columns, ["v1", "nonce-abcd", "cipher-abcd", "abcd"]);
    })
    .await;
}

#[tokio::test]
async fn key_versions_in_use_lists_each_version_once() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        let bo = seed_user(&db, "bo@example.com").await;
        assert!(keys::key_versions_in_use(&db).await.unwrap().is_empty());
        save(&db, &ana.id, AiProvider::Anthropic, "a").await;
        save(&db, &bo.id, AiProvider::Anthropic, "b").await;
        let newer = EncryptedKey {
            key_version: "v2".into(),
            ..sealed("c")
        };
        keys::upsert(&db, &bo.id, AiProvider::Openai, &newer, "c")
            .await
            .unwrap();
        assert_eq!(keys::key_versions_in_use(&db).await.unwrap(), ["v1", "v2"]);
    })
    .await;
}

#[tokio::test]
async fn the_database_rejects_an_unknown_provider() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        let result = sqlx::query(
            "INSERT INTO user_api_keys \
             (user_id, provider, key_version, nonce, ciphertext, last4, created_at, updated_at) \
             VALUES ($1, 'gemini', 'v1', 'n', 'c', 'abcd', 1, 1)",
        )
        .bind(&ana.id)
        .execute(db.pool())
        .await;
        assert!(result.is_err());
    })
    .await;
}

#[tokio::test]
async fn deleting_a_user_removes_their_keys_and_settings_but_nobody_elses() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        let bo = seed_user(&db, "bo@example.com").await;
        for user in [&ana, &bo] {
            save(&db, &user.id, AiProvider::Anthropic, "an11").await;
            save(&db, &user.id, AiProvider::Openai, "oa22").await;
        }
        assert_eq!(count(&db, "user_api_keys").await, 4);
        assert_eq!(count(&db, "user_ai_settings").await, 2);

        users::delete(&db, "ana@example.com").await.unwrap();

        assert_eq!(count(&db, "user_api_keys").await, 2);
        assert_eq!(count(&db, "user_ai_settings").await, 1);
        assert!(keys::summary(&db, &ana.id).await.unwrap().keys.is_empty());
        assert_eq!(keys::summary(&db, &bo.id).await.unwrap().keys.len(), 2);
    })
    .await;
}

/// Not a proof, since the interleaving is up to the scheduler: it checks the invariant after
/// each round. Correctness rests on every write taking the user's settings row lock first,
/// which orders the two writes so the later one always sees the earlier one's result.
#[tokio::test]
async fn concurrent_set_active_and_delete_never_leave_an_active_provider_without_a_key() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        for round in 0..25 {
            save(&db, &ana.id, AiProvider::Anthropic, "an11").await;
            save(&db, &ana.id, AiProvider::Openai, "oa22").await;
            keys::set_active(&db, &ana.id, AiProvider::Anthropic)
                .await
                .unwrap();
            let (d, s) = (db.clone(), db.clone());
            let id = ana.id.clone();
            let id2 = id.clone();
            let delete =
                tokio::spawn(async move { keys::delete(&d, &id, AiProvider::Openai).await });
            let switch =
                tokio::spawn(async move { keys::set_active(&s, &id2, AiProvider::Openai).await });
            delete.await.unwrap().unwrap();
            let _ = switch.await.unwrap();

            let summary = keys::summary(&db, &ana.id).await.unwrap();
            if let Some(active) = summary.active_provider {
                assert!(
                    summary.keys.iter().any(|k| k.provider == active),
                    "round {round}: active {active:?} has no key"
                );
            }
            let recorded: Option<String> =
                sqlx::query("SELECT active_provider FROM user_ai_settings WHERE user_id = $1")
                    .bind(&ana.id)
                    .fetch_one(db.pool())
                    .await
                    .unwrap()
                    .get(0);
            if let Some(recorded) = recorded {
                assert!(
                    summary.keys.iter().any(|k| k.provider.as_str() == recorded),
                    "round {round}: stored active {recorded} has no key"
                );
            }
            keys::delete(&db, &ana.id, AiProvider::Anthropic)
                .await
                .unwrap();
            keys::delete(&db, &ana.id, AiProvider::Openai)
                .await
                .unwrap();
        }
    })
    .await;
}

#[tokio::test]
async fn a_recorded_active_provider_without_a_key_is_never_reported() {
    on_every_backend(|db| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        save(&db, &ana.id, AiProvider::Anthropic, "an11").await;
        // Simulates the stale state the old race produced.
        sqlx::query("UPDATE user_ai_settings SET active_provider = 'openai' WHERE user_id = $1")
            .bind(&ana.id)
            .execute(db.pool())
            .await
            .unwrap();
        assert_eq!(
            keys::summary(&db, &ana.id).await.unwrap().active_provider,
            None
        );
        assert!(keys::active_key(&db, &ana.id).await.unwrap().is_none());

        // The next save repairs it instead of keeping the stale value.
        save(&db, &ana.id, AiProvider::Anthropic, "an33").await;
        assert_eq!(
            keys::summary(&db, &ana.id).await.unwrap().active_provider,
            Some(AiProvider::Anthropic)
        );
    })
    .await;
}
