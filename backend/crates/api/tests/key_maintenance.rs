//! Operator key maintenance: generating, rotating and purging master keys, and the startup
//! check that refuses a keyring missing a version still in use.

mod common;

use std::future::Future;

use api::cli::{generate_master_key, purge_keys, rotate_keys, CliError};
use api::config::{Config, Keyring, AI_PROVIDER, DATABASE_URL, ENV, MASTER_KEYS};
use api::db::Db;
use api::keys::{self, AiProvider, EncryptedKey, UserApiKey};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use common::db::{postgres_test_db_if_configured, sqlite_test_db};
use common::session::seed_user;
use sqlx::Row;

async fn on_every_backend<F, Fut>(test: F)
where
    F: Fn(Db, String) -> Fut,
    Fut: Future<Output = ()>,
{
    let sqlite = sqlite_test_db().await;
    test((*sqlite).clone(), sqlite.url().to_string()).await;
    if let Some(postgres) = postgres_test_db_if_configured().await {
        test((*postgres).clone(), postgres.url().to_string()).await;
        drop(postgres);
    }
    drop(sqlite);
}

/// A keyring in which `v1` is gone, which is what proves its keys are unrecoverable.
fn without_v1() -> Keyring {
    ring(&[("v2", 2)])
}

fn entry(version: &str, byte: u8) -> String {
    format!("{version}:{}", BASE64.encode([byte; 32]))
}

fn ring(entries: &[(&str, u8)]) -> Keyring {
    let spec: Vec<String> = entries.iter().map(|(v, b)| entry(v, *b)).collect();
    Keyring::parse(&spec.join(",")).unwrap()
}

async fn seed_key(db: &Db, keyring: &Keyring, user_id: &str, provider: AiProvider, key: &str) {
    let key = UserApiKey::new(key.to_string());
    let sealed = keys::encrypt(keyring, user_id, provider, &key).unwrap();
    keys::upsert(db, user_id, provider, &sealed, &key.last4())
        .await
        .unwrap();
}

async fn stored(db: &Db, user_id: &str, provider: AiProvider) -> EncryptedKey {
    let row = sqlx::query(
        "SELECT key_version, nonce, ciphertext FROM user_api_keys \
         WHERE user_id = $1 AND provider = $2",
    )
    .bind(user_id)
    .bind(provider.as_str())
    .fetch_one(db.pool())
    .await
    .unwrap();
    EncryptedKey {
        key_version: row.get(0),
        nonce: row.get(1),
        ciphertext: row.get(2),
    }
}

fn plaintext(
    keyring: &Keyring,
    user_id: &str,
    provider: AiProvider,
    sealed: &EncryptedKey,
) -> String {
    keys::decrypt(keyring, user_id, provider, sealed)
        .unwrap()
        .expose_secret()
        .to_string()
}

#[test]
fn generate_master_key_starts_at_v1_and_continues_past_the_highest_version() {
    assert!(generate_master_key(None).starts_with("v1:"));
    let existing = ring(&[("v2", 2), ("v1", 1)]);
    let next = generate_master_key(Some(&existing));
    assert!(next.starts_with("v3:"), "{next}");
    let odd = ring(&[("blue", 1), ("v7", 2)]);
    assert!(generate_master_key(Some(&odd)).starts_with("v8:"));
    let only_names = ring(&[("blue", 1)]);
    assert!(generate_master_key(Some(&only_names)).starts_with("v1:"));
}

#[test]
fn a_generated_entry_is_a_valid_keyring_and_never_repeats() {
    let (a, b) = (generate_master_key(None), generate_master_key(None));
    assert_ne!(a, b);
    let parsed = Keyring::parse(&a).unwrap();
    assert_eq!(parsed.versions().collect::<Vec<_>>(), ["v1"]);
    let combined = Keyring::parse(&format!("v2:{},{}", a.strip_prefix("v1:").unwrap(), b)).unwrap();
    assert_eq!(combined.versions().collect::<Vec<_>>(), ["v2", "v1"]);
}

#[tokio::test]
async fn rotate_moves_every_key_to_the_current_version_and_each_still_decrypts() {
    on_every_backend(|db, _| async move {
        let old = ring(&[("v1", 1)]);
        let rotated = ring(&[("v2", 2), ("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        let bo = seed_user(&db, "bo@example.com").await;
        seed_key(&db, &old, &ana.id, AiProvider::Anthropic, "sk-ant-ana-key-1111").await;
        seed_key(&db, &old, &bo.id, AiProvider::Openai, "sk-bo-key-2222").await;
        seed_key(&db, &rotated, &bo.id, AiProvider::Anthropic, "sk-ant-bo-key-3333").await;

        let output = rotate_keys(&db, &rotated).await.unwrap();
        assert_eq!(
            output,
            "Re-encrypted 2 keys under v2; 1 already on v2; 0 could not be decrypted (left unchanged).\nNo keys remain on older versions, so they can be dropped from SONGBIRD_MASTER_KEYS."
        );
        for (user, provider, expected) in [
            (&ana, AiProvider::Anthropic, "sk-ant-ana-key-1111"),
            (&bo, AiProvider::Openai, "sk-bo-key-2222"),
            (&bo, AiProvider::Anthropic, "sk-ant-bo-key-3333"),
        ] {
            let sealed = stored(&db, &user.id, provider).await;
            assert_eq!(sealed.key_version, "v2");
            assert_eq!(plaintext(&rotated, &user.id, provider, &sealed), expected);
        }
        assert!(!output.contains("sk-"));

        let again = keys::rotate(&db, &rotated).await.unwrap();
        assert_eq!(
            (again.rewritten, again.already_current, again.undecryptable),
            (0, 3, 0)
        );
    })
    .await;
}

#[tokio::test]
async fn rotate_leaves_undecryptable_rows_untouched_and_counts_them() {
    on_every_backend(|db, _| async move {
        let lost = ring(&[("v1", 1)]);
        let keyring = ring(&[("v3", 3), ("v2", 2)]);
        let ana = seed_user(&db, "ana@example.com").await;
        let bo = seed_user(&db, "bo@example.com").await;
        seed_key(
            &db,
            &lost,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;
        seed_key(
            &db,
            &keyring,
            &bo.id,
            AiProvider::Anthropic,
            "sk-ant-bo-key-3333",
        )
        .await;
        let mut corrupt = stored(&db, &bo.id, AiProvider::Anthropic).await;
        corrupt.key_version = "v2".into();
        keys::upsert(&db, &bo.id, AiProvider::Anthropic, &corrupt, "3333")
            .await
            .unwrap();
        let before_ana = stored(&db, &ana.id, AiProvider::Anthropic).await;
        let before_bo = stored(&db, &bo.id, AiProvider::Anthropic).await;

        let report = keys::rotate(&db, &keyring).await.unwrap();
        assert_eq!(
            (
                report.rewritten,
                report.already_current,
                report.undecryptable
            ),
            (0, 0, 2)
        );
        let output = rotate_keys(&db, &keyring).await.unwrap();
        assert!(
            output.contains("2 could not be decrypted (left unchanged)"),
            "{output}"
        );
        assert!(
            output.contains("2 keys are still on older versions; keep those versions"),
            "{output}"
        );
        assert_eq!(
            stored(&db, &ana.id, AiProvider::Anthropic).await,
            before_ana
        );
        assert_eq!(stored(&db, &bo.id, AiProvider::Anthropic).await, before_bo);
    })
    .await;
}

#[tokio::test]
async fn a_save_landing_mid_rotation_is_not_overwritten() {
    on_every_backend(|db, _| async move {
        let old = ring(&[("v1", 1)]);
        let rotated = ring(&[("v2", 2), ("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        let bo = seed_user(&db, "bo@example.com").await;
        seed_key(
            &db,
            &old,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-OLD-key",
        )
        .await;
        seed_key(
            &db,
            &old,
            &bo.id,
            AiProvider::Anthropic,
            "sk-ant-bo-key-3333",
        )
        .await;

        let report = keys::rotate_with_hook(&db, &rotated, || async {
            // Rotation must lose to a user's save that lands after its read, never overwrite it.
            seed_key(
                &db,
                &rotated,
                &ana.id,
                AiProvider::Anthropic,
                "sk-ant-ana-NEW-key",
            )
            .await;
        })
        .await
        .unwrap();

        assert_eq!(report.rewritten, 1);
        let sealed = stored(&db, &ana.id, AiProvider::Anthropic).await;
        assert_eq!(sealed.key_version, "v2");
        assert_eq!(
            plaintext(&rotated, &ana.id, AiProvider::Anthropic, &sealed),
            "sk-ant-ana-NEW-key"
        );
        let bo_sealed = stored(&db, &bo.id, AiProvider::Anthropic).await;
        assert_eq!(bo_sealed.key_version, "v2");
        assert_eq!(
            plaintext(&rotated, &bo.id, AiProvider::Anthropic, &bo_sealed),
            "sk-ant-bo-key-3333"
        );
    })
    .await;
}

#[tokio::test]
async fn a_replacement_under_the_same_old_version_is_not_overwritten_either() {
    on_every_backend(|db, _| async move {
        let old = ring(&[("v1", 1)]);
        let rotated = ring(&[("v2", 2), ("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &old,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-OLD-key",
        )
        .await;

        keys::rotate_with_hook(&db, &rotated, || async {
            seed_key(
                &db,
                &old,
                &ana.id,
                AiProvider::Anthropic,
                "sk-ant-ana-NEW-key",
            )
            .await;
        })
        .await
        .unwrap();

        let sealed = stored(&db, &ana.id, AiProvider::Anthropic).await;
        assert_eq!(sealed.key_version, "v1");
        assert_eq!(
            plaintext(&rotated, &ana.id, AiProvider::Anthropic, &sealed),
            "sk-ant-ana-NEW-key"
        );
    })
    .await;
}

#[tokio::test]
async fn purge_deletes_only_the_named_version_and_repairs_the_active_choice() {
    on_every_backend(|db, _| async move {
        let lost = ring(&[("v1", 1)]);
        let current = ring(&[("v2", 2)]);
        let ana = seed_user(&db, "ana@example.com").await;
        let bo = seed_user(&db, "bo@example.com").await;
        // Ana's active key is among the lost ones, which is what forces the fallback to be exercised.
        seed_key(
            &db,
            &lost,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;
        seed_key(
            &db,
            &current,
            &ana.id,
            AiProvider::Openai,
            "sk-ana-openai-2222",
        )
        .await;
        seed_key(
            &db,
            &current,
            &bo.id,
            AiProvider::Anthropic,
            "sk-ant-bo-key-3333",
        )
        .await;
        seed_key(&db, &lost, &bo.id, AiProvider::Openai, "sk-bo-openai-4444").await;

        let output = purge_keys(&db, &without_v1(), "v1", true, None)
            .await
            .unwrap();
        assert_eq!(
            output,
            "Deleted 2 stored keys encrypted under master key version v1."
        );

        let ana_summary = keys::summary(&db, &ana.id).await.unwrap();
        assert_eq!(ana_summary.keys.len(), 1);
        assert_eq!(ana_summary.active_provider, Some(AiProvider::Openai));
        let bo_summary = keys::summary(&db, &bo.id).await.unwrap();
        assert_eq!(bo_summary.keys.len(), 1);
        assert_eq!(bo_summary.active_provider, Some(AiProvider::Anthropic));
        assert_eq!(keys::key_versions_in_use(&db).await.unwrap(), ["v2"]);
    })
    .await;
}

#[tokio::test]
async fn purge_clears_the_active_provider_when_no_key_remains() {
    on_every_backend(|db, _| async move {
        let lost = ring(&[("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &lost,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;
        purge_keys(&db, &without_v1(), "v1", true, None)
            .await
            .unwrap();
        let summary = keys::summary(&db, &ana.id).await.unwrap();
        assert!(summary.keys.is_empty() && summary.active_provider.is_none());
        assert!(keys::active_key(&db, &ana.id).await.unwrap().is_none());
    })
    .await;
}

#[tokio::test]
async fn purge_needs_confirmation_unless_yes_is_given() {
    on_every_backend(|db, _| async move {
        let lost = ring(&[("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &lost,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;

        for retyped in [None, Some("v2"), Some("")] {
            let err = purge_keys(&db, &without_v1(), "v1", false, retyped)
                .await
                .unwrap_err();
            assert!(matches!(err, CliError::PurgeNotConfirmed), "{err}");
            assert_eq!(keys::summary(&db, &ana.id).await.unwrap().keys.len(), 1);
        }
        let output = purge_keys(&db, &without_v1(), "v1", false, Some("v1"))
            .await
            .unwrap();
        assert!(output.starts_with("Deleted 1 "), "{output}");
    })
    .await;
}

fn per_user_config(url: &str, keyring: &str) -> Config {
    Config::from_lookup(|k| match k {
        ENV => Some("development".into()),
        AI_PROVIDER => Some("user-mock".into()),
        MASTER_KEYS => Some(keyring.into()),
        DATABASE_URL => Some(url.into()),
        _ => None,
    })
    .unwrap()
}

#[tokio::test]
async fn startup_refuses_a_keyring_missing_a_version_that_stored_keys_use() {
    on_every_backend(|db, url| async move {
        let old = ring(&[("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &old,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;

        let config = per_user_config(&url, &entry("v2", 2));
        let message = api::startup::build_state(config).await.err().unwrap();
        assert!(message.contains("v1"), "{message}");
        assert!(message.contains("api keys rotate"), "{message}");
        assert!(message.contains(MASTER_KEYS), "{message}");
        assert!(!message.contains(&BASE64.encode([1u8; 32])), "{message}");

        let kept = per_user_config(&url, &format!("{},{}", entry("v2", 2), entry("v1", 1)));
        assert!(api::startup::build_state(kept).await.is_ok());

        // Purging the lost version is the documented way out, after which startup passes.
        purge_keys(&db, &without_v1(), "v1", true, None)
            .await
            .unwrap();
        let only_new = per_user_config(&url, &entry("v2", 2));
        assert!(api::startup::build_state(only_new).await.is_ok());
    })
    .await;
}

#[tokio::test]
async fn startup_does_not_check_versions_outside_per_user_mode() {
    on_every_backend(|db, url| async move {
        let old = ring(&[("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &old,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;
        let config = Config::from_lookup(|k| match k {
            ENV => Some("development".into()),
            AI_PROVIDER => Some("mock".into()),
            MASTER_KEYS => Some(entry("v2", 2)),
            DATABASE_URL => Some(url.clone()),
            _ => None,
        })
        .unwrap();
        assert!(api::startup::build_state(config).await.is_ok());
    })
    .await;
}

#[tokio::test]
async fn purge_refuses_a_version_the_keyring_still_holds_even_the_current_one() {
    on_every_backend(|db, _| async move {
        let keyring = ring(&[("v2", 2), ("v1", 1)]);
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &keyring,
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;
        seed_key(
            &db,
            &ring(&[("v1", 1)]),
            &ana.id,
            AiProvider::Openai,
            "sk-ana-openai-2222",
        )
        .await;

        for version in ["v1", "v2"] {
            let err = purge_keys(&db, &keyring, version, true, None)
                .await
                .unwrap_err();
            assert!(matches!(err, CliError::VersionStillInKeyring(_)), "{err}");
            let message = err.to_string();
            assert!(message.contains("api keys rotate"), "{message}");
            assert!(message.contains("remove that version"), "{message}");
            assert_eq!(keys::summary(&db, &ana.id).await.unwrap().keys.len(), 2);
        }
    })
    .await;
}

#[tokio::test]
async fn purging_a_version_no_row_uses_says_so_and_asks_no_confirmation() {
    on_every_backend(|db, _| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &ring(&[("v2", 2)]),
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;
        let output = purge_keys(&db, &without_v1(), "v9", false, None)
            .await
            .unwrap();
        assert_eq!(
            output,
            "No stored keys use version v9; nothing was deleted."
        );
        assert_eq!(keys::summary(&db, &ana.id).await.unwrap().keys.len(), 1);
    })
    .await;
}

#[tokio::test]
async fn the_purge_preflight_reports_the_row_count_or_refuses_before_any_prompt() {
    on_every_backend(|db, _| async move {
        let ana = seed_user(&db, "ana@example.com").await;
        seed_key(
            &db,
            &ring(&[("v1", 1)]),
            &ana.id,
            AiProvider::Anthropic,
            "sk-ant-ana-key-1111",
        )
        .await;
        assert_eq!(
            api::cli::purge_preflight(&db, &without_v1(), "v1")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            api::cli::purge_preflight(&db, &without_v1(), "v9")
                .await
                .unwrap(),
            0
        );
        let live = ring(&[("v2", 2), ("v1", 1)]);
        assert!(matches!(
            api::cli::purge_preflight(&db, &live, "v1").await,
            Err(CliError::VersionStillInKeyring(_))
        ));
    })
    .await;
}
