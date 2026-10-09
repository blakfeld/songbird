mod common;

use api::clock::now_ms;
use api::db::Db;
use api::project_store::{self, SongFacts, MAX_STORED_BYTES_PER_USER};
use api::share_store::{
    self as store, NewComment, NewShare, ShareEdit, ShareError, ShareMode,
    MAX_ACTIVE_SHARES_PER_PROJECT, MAX_COMMENTS_PER_SHARE,
};
use api::token::generate_token;
use common::app::sectioned_song;
use common::db::{test_db, TestDb};
use common::session::seed_user;
use secrecy::ExposeSecret;
use sqlx::Row;

struct Fixture {
    db: TestDb,
    owner: String,
    other: String,
    project: String,
}

async fn fixture() -> Fixture {
    let db = test_db().await;
    let owner = seed_user(&db, "owner@example.com").await.id;
    let other = seed_user(&db, "other@example.com").await.id;
    let project = new_project(&db, &owner).await;
    Fixture {
        db,
        owner,
        other,
        project,
    }
}

async fn new_project(db: &Db, owner: &str) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    let mut song = sectioned_song("Demo");
    song["id"] = serde_json::json!(id);
    let facts = SongFacts {
        name: "Demo".into(),
        time_signature: "4/4".into(),
        track_count: 1,
        song_json: song.to_string(),
    };
    project_store::create(db, owner, &id, &facts).await.unwrap();
    id
}

fn new_share(mode: ShareMode) -> NewShare {
    NewShare {
        mode,
        label: "Band".into(),
        expires_at: None,
        allow_comments: true,
        allow_downloads: false,
    }
}

async fn add_share(f: &Fixture, mode: ShareMode) -> (String, String) {
    let token = generate_token();
    let share = store::create(
        &f.db,
        &f.owner,
        &f.project,
        &new_share(mode),
        token.expose_secret(),
    )
    .await
    .unwrap();
    (share.id, token.expose_secret().to_string())
}

fn comment(at_step: i64) -> NewComment {
    NewComment {
        name: "Sam".into(),
        body: "Love this".into(),
        at_step,
        section_id: Some("sec-chorus".into()),
        section_name: Some("Chorus".into()),
        project_revision: Some(1),
    }
}

async fn scalar(db: &Db, sql: &str) -> i64 {
    sqlx::query(sql).fetch_one(db.pool()).await.unwrap().get(0)
}

#[tokio::test]
async fn a_project_holds_at_most_20_unrevoked_links_and_revoking_frees_a_slot() {
    let f = fixture().await;
    let mut first = None;
    for _ in 0..MAX_ACTIVE_SHARES_PER_PROJECT {
        let (id, _) = add_share(&f, ShareMode::Live).await;
        first.get_or_insert(id);
    }
    let token = generate_token();
    let refused = store::create(
        &f.db,
        &f.owner,
        &f.project,
        &new_share(ShareMode::Live),
        token.expose_secret(),
    )
    .await;
    assert!(matches!(refused, Err(ShareError::ShareLimit)));

    store::revoke(&f.db, &f.owner, &f.project, &first.unwrap())
        .await
        .unwrap();
    add_share(&f, ShareMode::Live).await;
    let listed = store::list(&f.db, &f.owner, &f.project).await.unwrap();
    assert_eq!(listed.len(), 21, "revoked links stay listed");
}

#[tokio::test]
async fn snapshot_bytes_count_toward_the_quota_and_are_freed_on_revoke() {
    let f = fixture().await;
    let (probe_id, _) = add_share(&f, ShareMode::Snapshot).await;
    let snapshot_len = scalar(&f.db, "SELECT snapshot_bytes FROM share_links").await;
    assert!(snapshot_len > 0);
    store::revoke(&f.db, &f.owner, &f.project, &probe_id)
        .await
        .unwrap();
    assert_eq!(
        scalar(&f.db, "SELECT snapshot_bytes FROM share_links").await,
        0
    );

    // Leaves room for exactly one snapshot beside the project itself.
    sqlx::query("UPDATE projects SET size_bytes = $1")
        .bind(MAX_STORED_BYTES_PER_USER - snapshot_len)
        .execute(f.db.pool())
        .await
        .unwrap();
    let (kept, _) = add_share(&f, ShareMode::Snapshot).await;
    let token = generate_token();
    let refused = store::create(
        &f.db,
        &f.owner,
        &f.project,
        &new_share(ShareMode::Snapshot),
        token.expose_secret(),
    )
    .await;
    assert!(matches!(refused, Err(ShareError::ProjectLimit)));
    // A live link stores no snapshot, so it fits whatever the quota is.
    add_share(&f, ShareMode::Live).await;

    store::revoke(&f.db, &f.owner, &f.project, &kept)
        .await
        .unwrap();
    add_share(&f, ShareMode::Snapshot).await;
}

#[tokio::test]
async fn a_snapshot_is_the_projected_song_as_saved_and_revoking_clears_it() {
    let f = fixture().await;
    let (id, token) = add_share(&f, ShareMode::Snapshot).await;
    let served = store::find_active(&f.db, &token, now_ms())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(served.song["sections"][0]["name"], "Verse");
    assert!(served.song.get("chat").is_none());
    assert!(served.song["sections"][0].get("notes").is_none());
    assert_eq!(served.project_revision, None);

    let stored: String = sqlx::query("SELECT snapshot FROM share_links")
        .fetch_one(f.db.pool())
        .await
        .unwrap()
        .get(0);
    assert!(
        !stored.contains("private"),
        "private text reached the table"
    );

    store::revoke(&f.db, &f.owner, &f.project, &id)
        .await
        .unwrap();
    let row = sqlx::query("SELECT snapshot FROM share_links")
        .fetch_one(f.db.pool())
        .await
        .unwrap();
    assert_eq!(row.try_get::<Option<String>, _>(0).unwrap(), None);
}

#[tokio::test]
async fn expired_revoked_unknown_and_malformed_tokens_are_not_found() {
    let f = fixture().await;
    let (active_id, active) = add_share(&f, ShareMode::Live).await;
    let (revoked_id, revoked) = add_share(&f, ShareMode::Live).await;
    let (expiring_id, expiring) = add_share(&f, ShareMode::Live).await;
    let now = now_ms();
    store::revoke(&f.db, &f.owner, &f.project, &revoked_id)
        .await
        .unwrap();
    store::update(
        &f.db,
        &f.owner,
        &f.project,
        &expiring_id,
        &ShareEdit {
            label: String::new(),
            expires_at: Some(now + 1000),
            allow_comments: true,
            allow_downloads: false,
        },
    )
    .await
    .unwrap();

    let find = |token: String, at: i64| {
        let db: Db = (*f.db).clone();
        async move { store::find_active(&db, &token, at).await.unwrap() }
    };
    assert!(find(active, now).await.is_some());
    assert!(find(revoked, now).await.is_none());
    assert!(find(expiring.clone(), now).await.is_some());
    assert!(find(expiring.clone(), now + 999).await.is_some());
    assert!(
        find(expiring, now + 1000 + 1).await.is_none(),
        "expired from the moment the clock reaches expires_at"
    );
    assert!(find(generate_token().expose_secret().to_string(), now)
        .await
        .is_none());
    assert!(find("abc".into(), now).await.is_none());
    let _ = active_id;
}

#[tokio::test]
async fn another_users_ids_are_not_found_for_every_owner_operation() {
    let f = fixture().await;
    let (share_id, token) = add_share(&f, ShareMode::Live).await;
    let stored = store::add_comment(&f.db, &share_id, &f.project, &comment(3))
        .await
        .unwrap();
    let edit = ShareEdit {
        label: "hijacked".into(),
        expires_at: None,
        allow_comments: false,
        allow_downloads: true,
    };
    let b = &f.other;
    let p = &f.project;

    let not_found = |r: Result<(), ShareError>| assert!(matches!(r, Err(ShareError::NotFound)));
    not_found(
        store::create(
            &f.db,
            b,
            p,
            &new_share(ShareMode::Live),
            generate_token().expose_secret(),
        )
        .await
        .map(|_| ()),
    );
    not_found(store::list(&f.db, b, p).await.map(|_| ()));
    not_found(store::get(&f.db, b, p, &share_id).await.map(|_| ()));
    not_found(
        store::update(&f.db, b, p, &share_id, &edit)
            .await
            .map(|_| ()),
    );
    not_found(store::revoke(&f.db, b, p, &share_id).await);
    not_found(store::list_comments(&f.db, b, p).await.map(|_| ()));
    not_found(
        store::set_comment_resolved(&f.db, b, p, &stored.id, true)
            .await
            .map(|_| ()),
    );
    not_found(store::delete_comment(&f.db, b, p, &stored.id).await);

    let share = store::get(&f.db, &f.owner, p, &share_id).await.unwrap();
    assert_eq!(share.label, "Band");
    assert!(share.revoked_at.is_none());
    let comments = store::list_comments(&f.db, &f.owner, p).await.unwrap();
    assert_eq!(comments.len(), 1);
    assert!(comments[0].resolved_at.is_none());
    assert!(store::find_active(&f.db, &token, now_ms())
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn a_comment_path_through_the_wrong_project_is_not_found() {
    let f = fixture().await;
    let (share_id, _) = add_share(&f, ShareMode::Live).await;
    let stored = store::add_comment(&f.db, &share_id, &f.project, &comment(3))
        .await
        .unwrap();
    let second_project = new_project(&f.db, &f.owner).await;
    assert!(matches!(
        store::delete_comment(&f.db, &f.owner, &second_project, &stored.id).await,
        Err(ShareError::NotFound)
    ));
    assert!(matches!(
        store::get(&f.db, &f.owner, &second_project, &share_id).await,
        Err(ShareError::NotFound)
    ));
}

#[tokio::test]
async fn resolving_keeps_the_first_time_and_reopening_clears_it() {
    let f = fixture().await;
    let (share_id, _) = add_share(&f, ShareMode::Live).await;
    let stored = store::add_comment(&f.db, &share_id, &f.project, &comment(3))
        .await
        .unwrap();
    let resolve =
        |resolved| store::set_comment_resolved(&f.db, &f.owner, &f.project, &stored.id, resolved);
    let first = resolve(true).await.unwrap().resolved_at.unwrap();
    let again = resolve(true).await.unwrap().resolved_at.unwrap();
    assert_eq!(first, again);
    assert_eq!(resolve(false).await.unwrap().resolved_at, None);
}

#[tokio::test]
async fn comments_are_listed_by_position_then_time_and_counted_when_unresolved() {
    let f = fixture().await;
    let (share_id, _) = add_share(&f, ShareMode::Live).await;
    let late = store::add_comment(&f.db, &share_id, &f.project, &comment(40))
        .await
        .unwrap();
    store::add_comment(&f.db, &share_id, &f.project, &comment(8))
        .await
        .unwrap();
    store::add_comment(&f.db, &share_id, &f.project, &comment(8))
        .await
        .unwrap();

    let listed = store::list_comments(&f.db, &f.owner, &f.project)
        .await
        .unwrap();
    let steps: Vec<i64> = listed.iter().map(|c| c.at_step).collect();
    assert_eq!(steps, [8, 8, 40]);
    assert!(listed[0].created_at <= listed[1].created_at);

    store::set_comment_resolved(&f.db, &f.owner, &f.project, &late.id, true)
        .await
        .unwrap();
    let share = store::get(&f.db, &f.owner, &f.project, &share_id)
        .await
        .unwrap();
    assert_eq!(share.unresolved_comments, 2);
}

#[tokio::test]
async fn a_comment_is_refused_once_the_link_stops_taking_comments_or_expires() {
    let f = fixture().await;
    let (share_id, _) = add_share(&f, ShareMode::Live).await;
    let edit = |expires_at, allow_comments| ShareEdit {
        label: "Band".into(),
        expires_at,
        allow_comments,
        allow_downloads: false,
    };

    store::update(&f.db, &f.owner, &f.project, &share_id, &edit(None, false))
        .await
        .unwrap();
    let off = store::add_comment(&f.db, &share_id, &f.project, &comment(0)).await;
    assert!(matches!(off, Err(ShareError::NotFound)));

    let past = Some(now_ms() - 1_000);
    store::update(&f.db, &f.owner, &f.project, &share_id, &edit(past, true))
        .await
        .unwrap();
    let expired = store::add_comment(&f.db, &share_id, &f.project, &comment(0)).await;
    assert!(matches!(expired, Err(ShareError::NotFound)));

    store::update(&f.db, &f.owner, &f.project, &share_id, &edit(None, true))
        .await
        .unwrap();
    store::add_comment(&f.db, &share_id, &f.project, &comment(0))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_link_holds_at_most_1000_comments() {
    let f = fixture().await;
    let (share_id, _) = add_share(&f, ShareMode::Live).await;
    let mut tx = f.db.pool().begin().await.unwrap();
    for n in 0..MAX_COMMENTS_PER_SHARE {
        sqlx::query(
            "INSERT INTO share_comments (id, share_id, project_id, author_name, body, at_step, \
             created_at) VALUES ($1, $2, $3, 'Sam', 'hi', 0, $4)",
        )
        .bind(format!("c{n}"))
        .bind(&share_id)
        .bind(&f.project)
        .bind(n)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let refused = store::add_comment(&f.db, &share_id, &f.project, &comment(0)).await;
    assert!(matches!(refused, Err(ShareError::CommentLimit)));
    assert_eq!(
        scalar(&f.db, "SELECT COUNT(*) FROM share_comments").await,
        MAX_COMMENTS_PER_SHARE
    );
}

#[tokio::test]
async fn deleting_a_project_removes_its_links_and_comments() {
    let f = fixture().await;
    let (share_id, token) = add_share(&f, ShareMode::Snapshot).await;
    store::add_comment(&f.db, &share_id, &f.project, &comment(0))
        .await
        .unwrap();

    project_store::delete(&f.db, &f.owner, &f.project)
        .await
        .unwrap();

    assert_eq!(scalar(&f.db, "SELECT COUNT(*) FROM share_links").await, 0);
    assert_eq!(
        scalar(&f.db, "SELECT COUNT(*) FROM share_comments").await,
        0
    );
    assert!(store::find_active(&f.db, &token, now_ms())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn deleting_a_user_removes_the_links_and_comments_of_all_their_projects() {
    let f = fixture().await;
    let second = new_project(&f.db, &f.owner).await;
    let (first_share, _) = add_share(&f, ShareMode::Live).await;
    let token = generate_token();
    let second_share = store::create(
        &f.db,
        &f.owner,
        &second,
        &new_share(ShareMode::Live),
        token.expose_secret(),
    )
    .await
    .unwrap();
    store::add_comment(&f.db, &first_share, &f.project, &comment(0))
        .await
        .unwrap();
    store::add_comment(&f.db, &second_share.id, &second, &comment(0))
        .await
        .unwrap();

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(&f.owner)
        .execute(f.db.pool())
        .await
        .unwrap();

    assert_eq!(scalar(&f.db, "SELECT COUNT(*) FROM share_links").await, 0);
    assert_eq!(
        scalar(&f.db, "SELECT COUNT(*) FROM share_comments").await,
        0
    );
    assert!(store::find_active(&f.db, token.expose_secret(), now_ms())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn only_a_hash_of_the_token_is_stored() {
    let f = fixture().await;
    let (_, token) = add_share(&f, ShareMode::Live).await;
    let row = sqlx::query("SELECT token_hash, token_prefix FROM share_links")
        .fetch_one(f.db.pool())
        .await
        .unwrap();
    let hash: String = row.get("token_hash");
    let prefix: String = row.get("token_prefix");
    assert_eq!(hash, api::token::hash_token(&token));
    assert_ne!(hash, token);
    assert_eq!(prefix, token[..6]);
    assert!(store::find_active(&f.db, &hash, now_ms())
        .await
        .unwrap()
        .is_none());
}
