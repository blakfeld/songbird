mod common;

use api::auth::password::{PasswordError, PasswordService, Verification};
use api::cli::{run_user_command, CliError, Inputs, UserCommand};
use api::db::Db;
use api::users;
use argon2::Params;
use common::db::test_db;
use common::session::login_as;
use secrecy::SecretString;
use sqlx::Row;

const PASSWORD: &str = "correct horse battery";

fn passwords() -> PasswordService {
    // Cheap parameters keep debug-build tests fast; the hashing rules are the same.
    PasswordService::with_params(Params::new(8, 1, 1, None).unwrap(), 2)
}

fn with_password(password: &str) -> Inputs {
    Inputs {
        password: Some(SecretString::from(password.to_string())),
        retyped_email: None,
    }
}

fn email(s: &str) -> String {
    s.to_string()
}

async fn sessions(db: &Db) -> i64 {
    sqlx::query("SELECT COUNT(*) FROM sessions")
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get::<i64, _>(0)
}

#[tokio::test]
async fn create_stores_a_verifiable_argon2id_hash_never_the_password() {
    let db = test_db().await;
    let svc = passwords();
    let out = run_user_command(
        &db,
        &svc,
        UserCommand::Create {
            email: email("Ana@Example.com"),
        },
        with_password(PASSWORD),
    )
    .await
    .unwrap();
    assert!(out.contains("ana@example.com"));

    let user = users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    assert!(user.password_hash.starts_with("$argon2id$"));
    assert!(!user.password_hash.contains(PASSWORD));
    assert_eq!(
        svc.verify(Some(&user.password_hash), &SecretString::from(PASSWORD))
            .await
            .unwrap(),
        Verification::Match {
            upgraded_hash: None
        }
    );
}

#[tokio::test]
async fn short_password_is_refused_and_creates_nothing() {
    let db = test_db().await;
    let err = run_user_command(
        &db,
        &passwords(),
        UserCommand::Create {
            email: email("ana@example.com"),
        },
        with_password("too short"),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(err, CliError::Password(PasswordError::Length)),
        "{err:?}"
    );
    assert!(users::list(&db).await.unwrap().is_empty());
}

#[tokio::test]
async fn missing_password_is_refused() {
    let db = test_db().await;
    let err = run_user_command(
        &db,
        &passwords(),
        UserCommand::Create {
            email: email("ana@example.com"),
        },
        Inputs::default(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CliError::PasswordRequired), "{err:?}");
}

#[tokio::test]
async fn duplicate_email_is_refused_with_a_clear_message() {
    let db = test_db().await;
    let svc = passwords();
    for address in ["ana@example.com", "ANA@example.com"] {
        let result = run_user_command(
            &db,
            &svc,
            UserCommand::Create {
                email: email(address),
            },
            with_password(PASSWORD),
        )
        .await;
        if address.starts_with("ANA") {
            assert!(result.unwrap_err().to_string().contains("already in use"));
        } else {
            result.unwrap();
        }
    }
}

#[tokio::test]
async fn set_password_ends_sessions_and_changes_the_hash() {
    let db = test_db().await;
    let svc = passwords();
    run_user_command(
        &db,
        &svc,
        UserCommand::Create {
            email: email("ana@example.com"),
        },
        with_password(PASSWORD),
    )
    .await
    .unwrap();
    let before = users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    login_as(&db, "ana@example.com").await;
    login_as(&db, "ana@example.com").await;
    assert_eq!(sessions(&db).await, 2);

    run_user_command(
        &db,
        &svc,
        UserCommand::SetPassword {
            email: email("ana@example.com"),
        },
        with_password("another long password"),
    )
    .await
    .unwrap();

    assert_eq!(sessions(&db).await, 0);
    let after = users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    assert_ne!(before.password_hash, after.password_hash);
}

#[tokio::test]
async fn set_password_with_a_short_password_keeps_the_old_one_and_the_sessions() {
    let db = test_db().await;
    let svc = passwords();
    run_user_command(
        &db,
        &svc,
        UserCommand::Create {
            email: email("ana@example.com"),
        },
        with_password(PASSWORD),
    )
    .await
    .unwrap();
    login_as(&db, "ana@example.com").await;

    let err = run_user_command(
        &db,
        &svc,
        UserCommand::SetPassword {
            email: email("ana@example.com"),
        },
        with_password("short"),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CliError::Password(PasswordError::Length)));
    assert_eq!(sessions(&db).await, 1);
}

#[tokio::test]
async fn disable_ends_sessions_and_enable_restores_the_account() {
    let db = test_db().await;
    let svc = passwords();
    login_as(&db, "ana@example.com").await;

    run_user_command(
        &db,
        &svc,
        UserCommand::Disable {
            email: email("ana@example.com"),
        },
        Inputs::default(),
    )
    .await
    .unwrap();
    assert_eq!(sessions(&db).await, 0);
    assert!(
        users::find_by_email(&db, "ana@example.com")
            .await
            .unwrap()
            .unwrap()
            .disabled
    );

    run_user_command(
        &db,
        &svc,
        UserCommand::Enable {
            email: email("ana@example.com"),
        },
        Inputs::default(),
    )
    .await
    .unwrap();
    assert!(
        !users::find_by_email(&db, "ana@example.com")
            .await
            .unwrap()
            .unwrap()
            .disabled
    );
}

#[tokio::test]
async fn delete_without_confirmation_leaves_the_account_in_place() {
    let db = test_db().await;
    login_as(&db, "ana@example.com").await;

    for retyped_email in [None, Some(email("someone-else@example.com"))] {
        let err = run_user_command(
            &db,
            &passwords(),
            UserCommand::Delete {
                email: email("ana@example.com"),
                yes: false,
            },
            Inputs {
                password: None,
                retyped_email,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, CliError::NotConfirmed), "{err:?}");
    }
    assert!(users::find_by_email(&db, "ana@example.com")
        .await
        .unwrap()
        .is_some());
    assert_eq!(sessions(&db).await, 1);
}

#[tokio::test]
async fn delete_with_yes_or_a_retyped_email_removes_the_account() {
    let db = test_db().await;
    login_as(&db, "ana@example.com").await;
    login_as(&db, "bo@example.com").await;
    let svc = passwords();

    run_user_command(
        &db,
        &svc,
        UserCommand::Delete {
            email: email("ana@example.com"),
            yes: true,
        },
        Inputs::default(),
    )
    .await
    .unwrap();
    run_user_command(
        &db,
        &svc,
        UserCommand::Delete {
            email: email("bo@example.com"),
            yes: false,
        },
        Inputs {
            password: None,
            retyped_email: Some(email("  BO@example.com ")),
        },
    )
    .await
    .unwrap();

    assert!(users::list(&db).await.unwrap().is_empty());
    assert_eq!(sessions(&db).await, 0);
}

#[tokio::test]
async fn list_shows_email_status_and_creation_time_but_no_hash() {
    let db = test_db().await;
    let svc = passwords();
    let empty = run_user_command(&db, &svc, UserCommand::List, Inputs::default())
        .await
        .unwrap();
    assert_eq!(empty, "No users.");

    login_as(&db, "ana@example.com").await;
    login_as(&db, "bo@example.com").await;
    users::set_disabled(&db, "bo@example.com", true)
        .await
        .unwrap();
    let out = run_user_command(&db, &svc, UserCommand::List, Inputs::default())
        .await
        .unwrap();
    let lines: Vec<Vec<&str>> = out.lines().map(|l| l.split('\t').collect()).collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(&lines[0][..2], ["ana@example.com", "active"]);
    assert_eq!(&lines[1][..2], ["bo@example.com", "disabled"]);
    assert!(lines[0][2].ends_with('Z') && lines[0][2].contains('T'));
    assert!(!out.contains('!'), "the stored hash must not be printed");
}

#[tokio::test]
async fn commands_on_an_unknown_account_report_it() {
    let db = test_db().await;
    let err = run_user_command(
        &db,
        &passwords(),
        UserCommand::Disable {
            email: email("ghost@example.com"),
        },
        Inputs::default(),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("No account"), "{err}");
}
