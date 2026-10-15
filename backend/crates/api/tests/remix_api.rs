mod common;

use axum::http::{header, StatusCode};
use common::app::{request, sectioned_song, Response, TestApp};
use common::share::*;
use serde_json::{json, Value};

const OWNER: &str = "owner@example.com";
const REMIXER: &str = "remixer@example.com";
const EVIL: (&str, &str) = ("origin", "https://evil.example");

struct Setup {
    app: TestApp,
    owner: String,
    remixer: String,
    project: String,
}

async fn setup_with(config: &[(&str, &str)]) -> Setup {
    let app = TestApp::new(config).await;
    let owner = app.cookie_for(OWNER).await;
    let remixer = app.cookie_for(REMIXER).await;
    let project = sectioned_project(&app, &owner).await;
    Setup {
        app,
        owner,
        remixer,
        project,
    }
}

async fn setup() -> Setup {
    setup_with(&[]).await
}

fn remixable(mode: &str) -> Value {
    json!({"mode": mode, "expires_at": null, "allow_comments": true,
           "allow_downloads": false, "allow_remix": true})
}

async fn remixable_token(s: &Setup, mode: &str) -> (String, String) {
    make_share(&s.app, &s.owner, &s.project, remixable(mode)).await
}

async fn project_list(app: &TestApp, cookie: &str) -> Vec<Value> {
    let listed = app
        .send(request("GET", "/api/v1/projects", Some(cookie), None))
        .await;
    listed.body["projects"].as_array().unwrap().clone()
}

async fn open(app: &TestApp, cookie: &str, id: &str) -> Response {
    app.send(request(
        "GET",
        &format!("/api/v1/projects/{id}"),
        Some(cookie),
        None,
    ))
    .await
}

async fn save_song(app: &TestApp, cookie: &str, id: &str, song: Value, revision: Value) {
    // Only this project's last-save time moves, so other projects' `updated_at` stays comparable.
    sqlx::query("UPDATE projects SET updated_at = updated_at - 5000 WHERE id = $1")
        .bind(id)
        .execute(app.db().pool())
        .await
        .unwrap();
    let saved = app
        .send(request(
            "PUT",
            &format!("/api/v1/projects/{id}"),
            Some(cookie),
            Some(json!({"song": song, "revision": revision})),
        ))
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
}

async fn rename_section(s: &Setup, from: &str, to: &str) {
    let opened = open(&s.app, &s.owner, &s.project).await;
    let mut song = opened.body["project"]["song"].clone();
    for section in song["sections"].as_array_mut().unwrap() {
        if section["name"] == from {
            section["name"] = json!(to);
        }
    }
    save_song(
        &s.app,
        &s.owner,
        &s.project,
        song,
        opened.body["project"]["revision"].clone(),
    )
    .await;
}

fn section_names(song: &Value) -> Vec<String> {
    song["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_signed_in_user_remixes_an_allowed_link_into_a_new_project_of_their_own() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;

    let response = remix(&s.app, Some(&s.remixer), &token).await;

    assert_eq!(response.status, StatusCode::CREATED, "{:?}", response.body);
    let project = &response.body["project"];
    assert_eq!(project["revision"], 1);
    assert!(project["updated_at"].as_i64().unwrap() > 0);
    let id = project["id"].as_str().unwrap();
    assert_ne!(id, s.project);
    assert_eq!(project["song"]["id"], id);
    let mine = project_list(&s.app, &s.remixer).await;
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["id"], id);
    assert_eq!(project_list(&s.app, &s.owner).await.len(), 1);
    let opened = open(&s.app, &s.remixer, id).await;
    assert_eq!(opened.body["project"]["song"], project["song"]);
}

#[tokio::test]
async fn remixing_needs_a_session_and_creates_nothing_without_one() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;

    let response = remix(&s.app, None, &token).await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.body["error"]["code"], "unauthenticated");
    assert_eq!(count(&s.app, "projects").await, 1);
}

#[tokio::test]
async fn a_link_that_does_not_allow_remixing_gets_the_same_404_as_a_dead_token() {
    let s = setup().await;
    let (_, off) = make_share(&s.app, &s.owner, &s.project, live_body()).await;

    let never_issued = remix(&s.app, Some(&s.remixer), &"A".repeat(43)).await;
    let refused = remix(&s.app, Some(&s.remixer), &off).await;

    assert_eq!(never_issued.status, StatusCode::NOT_FOUND);
    assert_eq!(never_issued.body["error"]["code"], "not_found");
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    assert_eq!(refused.body, never_issued.body);
    assert!(project_list(&s.app, &s.remixer).await.is_empty());
}

#[tokio::test]
async fn revoked_expired_and_deleted_links_are_404() {
    let s = setup().await;
    let (revoked_id, revoked) = remixable_token(&s, "live").await;
    revoke(&s.app, &s.owner, &s.project, &revoked_id).await;
    let (_, expired) = remixable_token(&s, "live").await;
    sqlx::query("UPDATE share_links SET expires_at = $1 WHERE token_hash = $2")
        .bind(api::clock::now_ms() - 1)
        .bind(api::token::hash_token(&expired))
        .execute(s.app.db().pool())
        .await
        .unwrap();
    let (_, deleted) = remixable_token(&s, "snapshot").await;
    let removed = s
        .app
        .send(request(
            "DELETE",
            &format!("/api/v1/projects/{}", s.project),
            Some(&s.owner),
            None,
        ))
        .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT);

    for token in [revoked, expired, deleted, "abc".to_string()] {
        let response = remix(&s.app, Some(&s.remixer), &token).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{token}");
        assert_eq!(response.body["error"]["code"], "not_found", "{token}");
    }
    assert!(project_list(&s.app, &s.remixer).await.is_empty());
}

#[tokio::test]
async fn a_song_in_the_request_body_is_ignored() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;

    let response = s
        .app
        .send(listen_request(
            "POST",
            &format!("/api/v1/listen/{token}/remix"),
            &[("cookie", s.remixer.as_str())],
            Some(json!({"song": sectioned_song("Forged"), "name": "Forged"})),
        ))
        .await;

    assert_eq!(response.status, StatusCode::CREATED);
    assert_eq!(
        response.body["project"]["song"]["name"],
        "Late Train (remix)"
    );
}

#[tokio::test]
async fn the_owners_chat_lyric_chat_and_section_notes_are_not_copied_but_everything_else_is() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;

    let response = remix(&s.app, Some(&s.remixer), &token).await;

    assert_eq!(response.status, StatusCode::CREATED);
    let id = response.body["project"]["id"].as_str().unwrap();
    let stored = open(&s.app, &s.remixer, id).await;
    let copy = &stored.body["project"]["song"];
    let source = open(&s.app, &s.owner, &s.project).await;
    let original = &source.body["project"]["song"];
    assert!(copy.get("chat").is_none());
    assert!(copy.get("lyric_chat").is_none());
    for section in copy["sections"].as_array().unwrap() {
        assert!(section["notes"].as_str().unwrap().is_empty());
    }
    assert!(!stored.body.to_string().contains("private"));
    assert_eq!(copy["tracks"], original["tracks"]);
    assert_eq!(copy["lyrics"], original["lyrics"]);
    assert_eq!(section_names(copy), section_names(original));
    for field in [
        "tempo_bpm",
        "time_signature",
        "measures",
        "steps_per_measure",
    ] {
        assert_eq!(copy[field], original[field], "{field}");
    }
}

#[tokio::test]
async fn a_snapshot_link_remixes_the_song_as_it_was_shared() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "snapshot").await;
    rename_section(&s, "Chorus", "Hook").await;

    let response = remix(&s.app, Some(&s.remixer), &token).await;

    assert_eq!(response.status, StatusCode::CREATED);
    assert_eq!(
        section_names(&response.body["project"]["song"]),
        ["Verse", "Chorus"]
    );
}

#[tokio::test]
async fn a_live_link_remixes_the_latest_save_and_later_edits_do_not_reach_the_copy() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;
    rename_section(&s, "Chorus", "Bridge").await;

    let response = remix(&s.app, Some(&s.remixer), &token).await;
    rename_section(&s, "Bridge", "Hook").await;

    let id = response.body["project"]["id"].as_str().unwrap();
    let copy = open(&s.app, &s.remixer, id).await;
    assert_eq!(
        section_names(&copy.body["project"]["song"]),
        ["Verse", "Bridge"]
    );
}

#[tokio::test]
async fn the_copy_is_named_after_the_song_and_a_long_name_is_shortened_to_fit() {
    let s = setup().await;
    let long = "x".repeat(80);
    let long_project = create_project(&s.app, &s.owner, sectioned_song(&long)).await;
    let (_, long_token) = make_share(&s.app, &s.owner, &long_project, remixable("live")).await;
    let (_, token) = remixable_token(&s, "live").await;

    let plain = remix(&s.app, Some(&s.remixer), &token).await;
    let shortened = remix(&s.app, Some(&s.remixer), &long_token).await;

    assert_eq!(plain.body["project"]["song"]["name"], "Late Train (remix)");
    let name = shortened.body["project"]["song"]["name"].as_str().unwrap();
    assert_eq!(name.chars().count(), 80);
    assert!(name.ends_with("xxxx (remix)"), "{name}");
    let mine = project_list(&s.app, &s.remixer).await;
    assert!(mine.iter().any(|p| p["name"] == "Late Train (remix)"));
}

#[tokio::test]
async fn nothing_in_the_response_or_the_stored_copy_points_back_to_the_source() {
    let s = setup().await;
    let (share_id, token) = remixable_token(&s, "live").await;
    let owner = api::users::find_by_email(s.app.db(), OWNER)
        .await
        .unwrap()
        .unwrap();

    let response = remix(&s.app, Some(&s.remixer), &token).await;

    let id = response.body["project"]["id"].as_str().unwrap();
    let stored: String = sqlx::query_scalar("SELECT song FROM projects WHERE id = $1")
        .bind(id)
        .fetch_one(s.app.db().pool())
        .await
        .unwrap();
    for text in [response.body.to_string(), stored] {
        for private in [
            s.project.as_str(),
            owner.id.as_str(),
            OWNER,
            share_id.as_str(),
            token.as_str(),
        ] {
            assert!(!text.contains(private), "{private} leaked in {text}");
        }
    }
}

#[tokio::test]
async fn audio_tracks_and_sample_metadata_arrive_as_shared() {
    let s = setup().await;
    let mut song = sectioned_song("With Audio");
    song["samples"] = json!([{
        "id": "s1", "name": "Take 1", "sample_rate": 48000, "channels": 1,
        "length_samples": 96000, "origin": "import",
    }]);
    song["tracks"].as_array_mut().unwrap().push(json!({
        "id": "vox", "name": "Vocal", "instrument": "audio", "volume_db": 0, "pan": 0,
        "muted": false, "soloed": false, "loops": [], "clips": [],
        "audio_clips": [{
            "id": "a1", "sample_id": "s1", "start_ticks": 0, "offset_samples": 0,
            "slice_samples": 96000, "length_samples": 96000, "looping": false,
            "gain_db": 0, "fade_in_samples": 0, "fade_out_samples": 0,
        }],
    }));
    let project = create_project(&s.app, &s.owner, song).await;
    let (_, token) = make_share(&s.app, &s.owner, &project, remixable("live")).await;
    let original = open(&s.app, &s.owner, &project).await;

    let response = remix(&s.app, Some(&s.remixer), &token).await;

    assert_eq!(response.status, StatusCode::CREATED, "{:?}", response.body);
    let copy = &response.body["project"]["song"];
    let source = &original.body["project"]["song"];
    assert_eq!(copy["samples"], source["samples"]);
    assert_eq!(copy["tracks"], source["tracks"]);
}

#[tokio::test]
async fn remixing_leaves_the_source_project_links_and_comments_untouched() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;
    post_comment(&s.app, &token, comment_body(3)).await;
    let before = open(&s.app, &s.owner, &s.project).await;
    let comments_before = owner_comments(&s.app, &s.owner, &s.project).await;
    let updated_before: i64 = sqlx::query_scalar("SELECT updated_at FROM share_links")
        .fetch_one(s.app.db().pool())
        .await
        .unwrap();

    let response = remix(&s.app, Some(&s.remixer), &token).await;
    let id = response.body["project"]["id"].as_str().unwrap().to_string();
    let copy = open(&s.app, &s.remixer, &id).await;
    let mut edited = copy.body["project"]["song"].clone();
    edited["name"] = json!("My take");
    save_song(
        &s.app,
        &s.remixer,
        &id,
        edited,
        copy.body["project"]["revision"].clone(),
    )
    .await;

    let after = open(&s.app, &s.owner, &s.project).await;
    assert_eq!(after.body, before.body);
    assert_eq!(after.body["project"]["revision"], 1);
    assert_eq!(
        owner_comments(&s.app, &s.owner, &s.project).await.body,
        comments_before.body
    );
    let updated_after: i64 = sqlx::query_scalar("SELECT updated_at FROM share_links")
        .fetch_one(s.app.db().pool())
        .await
        .unwrap();
    assert_eq!(updated_after, updated_before);
    assert_eq!(count(&s.app, "share_links").await, 1);
}

#[tokio::test]
async fn a_remix_that_would_pass_the_project_limit_is_409_and_stores_nothing() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;
    let remixer = api::users::find_by_email(s.app.db(), REMIXER)
        .await
        .unwrap()
        .unwrap();
    let mut tx = s.app.db().pool().begin().await.unwrap();
    for n in 0..api::project_store::MAX_PROJECTS_PER_USER {
        sqlx::query(
            "INSERT INTO projects (id, owner_id, name, time_signature, track_count, song, \
             size_bytes, revision, created_at, updated_at) \
             VALUES ($1, $2, 'Filler', '4/4', 1, '{}', 2, 1, 0, 0)",
        )
        .bind(format!("filler-{n}"))
        .bind(&remixer.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let response = remix(&s.app, Some(&s.remixer), &token).await;

    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.body["error"]["code"], "project_limit");
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE owner_id = $1")
        .bind(&remixer.id)
        .fetch_one(s.app.db().pool())
        .await
        .unwrap();
    assert_eq!(owned, api::project_store::MAX_PROJECTS_PER_USER);
}

#[tokio::test]
async fn the_eleventh_remix_in_a_minute_is_429_with_retry_after() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;

    for n in 1..=10 {
        let ok = remix(&s.app, Some(&s.remixer), &token).await;
        assert_eq!(ok.status, StatusCode::CREATED, "remix {n}");
    }
    let limited = remix(&s.app, Some(&s.remixer), &token).await;

    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.body["error"]["code"], "too_many_requests");
    let retry: u64 = limited.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=61).contains(&retry));
    assert_eq!(project_list(&s.app, &s.remixer).await.len(), 10);
    let other = s.app.cookie_for("other@example.com").await;
    assert_eq!(
        remix(&s.app, Some(&other), &token).await.status,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn the_per_user_remix_limit_is_configurable() {
    let s = setup_with(&[("SONGBIRD_REMIXES_PER_MINUTE", "2")]).await;
    let (_, token) = remixable_token(&s, "live").await;

    assert_eq!(
        remix(&s.app, Some(&s.remixer), &token).await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        remix(&s.app, Some(&s.remixer), &token).await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        remix(&s.app, Some(&s.remixer), &token).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn remixes_count_toward_the_per_address_listen_budget() {
    let s = setup_with(&[("SONGBIRD_SHARE_READS_PER_MINUTE", "2")]).await;
    let (_, token) = remixable_token(&s, "live").await;

    assert_eq!(
        remix(&s.app, Some(&s.remixer), &token).await.status,
        StatusCode::CREATED
    );
    assert_eq!(listen(&s.app, &token).await.status, StatusCode::OK);
    let limited = remix(&s.app, Some(&s.remixer), &token).await;

    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers.contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn a_cross_site_remix_is_403_and_creates_nothing() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;

    let refused = s
        .app
        .send(listen_request(
            "POST",
            &format!("/api/v1/listen/{token}/remix"),
            &[("cookie", s.remixer.as_str()), EVIL],
            None,
        ))
        .await;

    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(refused.body["error"]["code"], "forbidden");
    assert!(project_list(&s.app, &s.remixer).await.is_empty());
    let allowed = s
        .app
        .send(listen_request(
            "POST",
            &format!("/api/v1/listen/{token}/remix"),
            &[("cookie", s.remixer.as_str()), allowed_origin()],
            None,
        ))
        .await;
    assert_eq!(allowed.status, StatusCode::CREATED);
}

#[tokio::test]
async fn the_owner_can_remix_their_own_link() {
    let s = setup().await;
    let (_, token) = remixable_token(&s, "live").await;

    let response = remix(&s.app, Some(&s.owner), &token).await;

    assert_eq!(response.status, StatusCode::CREATED);
    assert_eq!(project_list(&s.app, &s.owner).await.len(), 2);
}
