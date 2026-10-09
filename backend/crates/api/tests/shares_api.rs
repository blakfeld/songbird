mod common;

use api::clock::now_ms;
use api::project_store::MAX_STORED_BYTES_PER_USER;
use axum::http::StatusCode;
use common::app::{request, sectioned_song, TestApp};
use common::share::*;
use serde_json::{json, Value};

const DAY_MS: i64 = 24 * 3600 * 1000;

struct Setup {
    app: TestApp,
    cookie: String,
    project: String,
}

async fn setup() -> Setup {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("owner@example.com").await;
    let project = sectioned_project(&app, &cookie).await;
    Setup {
        app,
        cookie,
        project,
    }
}

fn snapshot_body() -> Value {
    json!({"mode": "snapshot", "expires_at": null, "allow_comments": true, "allow_downloads": true})
}

async fn rename_section(s: &Setup, from: &str, to: &str) {
    age_saves(&s.app).await;
    let open = s
        .app
        .send(request(
            "GET",
            &format!("/api/v1/projects/{}", s.project),
            Some(&s.cookie),
            None,
        ))
        .await;
    let mut song = open.body["project"]["song"].clone();
    for section in song["sections"].as_array_mut().unwrap() {
        if section["name"] == from {
            section["name"] = json!(to);
        }
    }
    let saved = s
        .app
        .send(request(
            "PUT",
            &format!("/api/v1/projects/{}", s.project),
            Some(&s.cookie),
            Some(json!({"song": song, "revision": open.body["project"]["revision"]})),
        ))
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
}

fn section_names(response: &common::app::Response) -> Vec<String> {
    response.body["song"]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn creating_a_live_link_returns_the_token_url_and_link_once() {
    let s = setup().await;

    let created = create_share(&s.app, &s.cookie, &s.project, live_body()).await;

    assert_eq!(created.status, StatusCode::CREATED);
    let token = created.body["token"].as_str().unwrap();
    assert_eq!(token.len(), 43);
    assert!(token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert_eq!(created.body["url"], format!("/listen/{token}"));
    let share = &created.body["share"];
    assert_eq!(share["mode"], "live");
    assert_eq!(share["status"], "active");
    assert_eq!(share["token_prefix"], token[..6]);
    assert_eq!(share["label"], "");
    assert_eq!(share["allow_comments"], true);
    assert_eq!(share["allow_downloads"], false);
    assert_eq!(share["expires_at"], Value::Null);
    assert_eq!(share["revoked_at"], Value::Null);
    assert_eq!(share["unresolved_comments"], 0);
    assert!(share["created_at"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn the_token_appears_only_in_the_create_response() {
    let s = setup().await;
    let created = create_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let token = created.body["token"].as_str().unwrap().to_string();
    let share_id = created.body["share"]["id"].as_str().unwrap().to_string();
    let hash = api::token::hash_token(&token);

    let listed = s
        .app
        .send(request(
            "GET",
            &format!("/api/v1/projects/{}/shares", s.project),
            Some(&s.cookie),
            None,
        ))
        .await;
    let edited = s
        .app
        .send(request(
            "PUT",
            &format!("/api/v1/projects/{}/shares/{share_id}", s.project),
            Some(&s.cookie),
            Some(json!({"label": "Band", "expires_at": null,
                        "allow_comments": true, "allow_downloads": true})),
        ))
        .await;

    assert_eq!(listed.status, StatusCode::OK);
    assert_eq!(edited.status, StatusCode::OK);
    for body in [&listed.body, &edited.body] {
        let text = body.to_string();
        assert!(!text.contains(&token), "{text}");
        assert!(!text.contains(&hash), "{text}");
        assert!(!text.contains("token_hash"), "{text}");
    }
    assert_eq!(listed.body["shares"][0]["id"], share_id);
    assert_eq!(listed.body["shares"][0]["token_prefix"], token[..6]);
}

#[tokio::test]
async fn a_snapshot_link_does_not_follow_later_edits() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, snapshot_body()).await;

    rename_section(&s, "Chorus", "Hook").await;

    let heard = listen(&s.app, &token).await;
    assert_eq!(section_names(&heard), ["Verse", "Chorus"]);
    assert_eq!(heard.body["share"]["mode"], "snapshot");
}

#[tokio::test]
async fn a_live_link_follows_later_edits() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    rename_section(&s, "Chorus", "Hook").await;

    assert_eq!(
        section_names(&listen(&s.app, &token).await),
        ["Verse", "Hook"]
    );
}

#[tokio::test]
async fn an_expiry_in_the_past_or_beyond_a_year_is_422_and_creates_nothing() {
    let s = setup().await;
    for expires_at in [now_ms() - 60_000, now_ms() + 366 * DAY_MS] {
        let mut body = live_body();
        body["expires_at"] = json!(expires_at);
        let response = create_share(&s.app, &s.cookie, &s.project, body).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(response.body["error"]["code"], "invalid_share");
    }
    assert_eq!(count(&s.app, "share_links").await, 0);

    let mut body = live_body();
    body["expires_at"] = json!(now_ms() + 365 * DAY_MS - 60_000);
    assert_eq!(
        create_share(&s.app, &s.cookie, &s.project, body)
            .await
            .status,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn malformed_settings_are_422_invalid_share() {
    let s = setup().await;
    let bad = [
        json!({"mode": "forever", "expires_at": null, "allow_comments": true, "allow_downloads": false}),
        json!({"expires_at": null, "allow_comments": true, "allow_downloads": false}),
        json!({"mode": "live", "expires_at": null, "allow_comments": "yes", "allow_downloads": false}),
        json!({"mode": "live", "expires_at": "tomorrow", "allow_comments": true, "allow_downloads": false}),
        json!({"mode": "live", "expires_at": null, "allow_comments": true, "allow_downloads": false, "extra": 1}),
        json!({"mode": "live", "expires_at": null, "allow_comments": true, "allow_downloads": false,
               "label": "x".repeat(81)}),
        json!({"mode": "live", "expires_at": null, "allow_comments": true, "allow_downloads": false,
               "label": "bell\u{7}"}),
    ];
    for body in bad {
        let response = create_share(&s.app, &s.cookie, &s.project, body.clone()).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(response.body["error"]["code"], "invalid_share", "{body}");
    }
    assert_eq!(count(&s.app, "share_links").await, 0);

    let mut ok = live_body();
    ok["label"] = json!("é".repeat(80));
    assert_eq!(
        create_share(&s.app, &s.cookie, &s.project, ok).await.status,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn the_21st_unrevoked_link_is_409_share_limit() {
    let s = setup().await;
    let mut first = String::new();
    for n in 0..20 {
        let (id, _) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
        if n == 0 {
            first = id;
        }
    }

    let refused = create_share(&s.app, &s.cookie, &s.project, live_body()).await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.body["error"]["code"], "share_limit");

    assert_eq!(
        revoke(&s.app, &s.cookie, &s.project, &first).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        create_share(&s.app, &s.cookie, &s.project, live_body())
            .await
            .status,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn a_snapshot_that_would_pass_the_storage_quota_is_409_project_limit() {
    let s = setup().await;
    sqlx::query("UPDATE projects SET size_bytes = $1")
        .bind(MAX_STORED_BYTES_PER_USER - 10)
        .execute(s.app.db().pool())
        .await
        .unwrap();

    let refused = create_share(&s.app, &s.cookie, &s.project, snapshot_body()).await;

    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.body["error"]["code"], "project_limit");
    assert_eq!(count(&s.app, "share_links").await, 0);
}

#[tokio::test]
async fn snapshots_filling_the_quota_make_a_project_save_409_project_limit() {
    let s = setup().await;
    make_share(&s.app, &s.cookie, &s.project, snapshot_body()).await;
    sqlx::query("UPDATE share_links SET snapshot_bytes = $1")
        .bind(MAX_STORED_BYTES_PER_USER)
        .execute(s.app.db().pool())
        .await
        .unwrap();
    age_saves(&s.app).await;

    let path = format!("/api/v1/projects/{}", s.project);
    let open = s
        .app
        .send(request("GET", &path, Some(&s.cookie), None))
        .await;
    let mut song = open.body["project"]["song"].clone();
    song["name"] = json!("Renamed with more bytes than before");
    let saved = s
        .app
        .send(request(
            "PUT",
            &path,
            Some(&s.cookie),
            Some(json!({"song": song, "revision": 1})),
        ))
        .await;

    assert_eq!(saved.status, StatusCode::CONFLICT);
    assert_eq!(saved.body["error"]["code"], "project_limit");
    let after = s
        .app
        .send(request("GET", &path, Some(&s.cookie), None))
        .await;
    assert_eq!(after.body["project"]["revision"], 1);
    assert_eq!(after.body["project"]["song"]["name"], "Late Train");
}

#[tokio::test]
async fn another_users_project_cannot_be_shared_and_nothing_is_created() {
    let s = setup().await;
    let other = s.app.cookie_for("other@example.com").await;

    let response = create_share(&s.app, &other, &s.project, live_body()).await;

    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.body["error"]["code"], "not_found");
    assert_eq!(count(&s.app, "share_links").await, 0);
    let missing = create_share(&s.app, &other, "never-used", live_body()).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.body["error"], response.body["error"]);
}

#[tokio::test]
async fn links_are_listed_newest_first_with_status_and_unresolved_counts() {
    let s = setup().await;
    let (older, older_token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let (middle, _) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let (newest, _) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    post_comment(&s.app, &older_token, comment_body(3)).await;
    post_comment(&s.app, &older_token, comment_body(4)).await;
    revoke(&s.app, &s.cookie, &s.project, &middle).await;
    sqlx::query("UPDATE share_links SET expires_at = $1 WHERE id = $2")
        .bind(now_ms() - 1)
        .bind(&newest)
        .execute(s.app.db().pool())
        .await
        .unwrap();

    let listed = s
        .app
        .send(request(
            "GET",
            &format!("/api/v1/projects/{}/shares", s.project),
            Some(&s.cookie),
            None,
        ))
        .await;

    let shares = listed.body["shares"].as_array().unwrap();
    let ids: Vec<&str> = shares.iter().map(|x| x["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [newest.as_str(), middle.as_str(), older.as_str()]);
    let statuses: Vec<&str> = shares
        .iter()
        .map(|x| x["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["expired", "revoked", "active"]);
    assert_eq!(shares[2]["unresolved_comments"], 2);
    assert!(shares[1]["revoked_at"].is_i64());
}

#[tokio::test]
async fn editing_changes_the_settings_but_not_the_mode_token_or_snapshot() {
    let s = setup().await;
    let (id, token) = make_share(&s.app, &s.cookie, &s.project, snapshot_body()).await;
    let expires_at = now_ms() + DAY_MS;

    let edited = s
        .app
        .send(request(
            "PUT",
            &format!("/api/v1/projects/{}/shares/{id}", s.project),
            Some(&s.cookie),
            Some(json!({"label": "  For Sam  ", "expires_at": expires_at,
                        "allow_comments": false, "allow_downloads": false})),
        ))
        .await;

    assert_eq!(edited.status, StatusCode::OK);
    let share = &edited.body["share"];
    assert_eq!(share["label"], "For Sam");
    assert_eq!(share["expires_at"], expires_at);
    assert_eq!(share["allow_comments"], false);
    assert_eq!(share["allow_downloads"], false);
    assert_eq!(share["mode"], "snapshot");
    let heard = listen(&s.app, &token).await;
    assert_eq!(heard.body["share"]["allow_comments"], false);
    assert_eq!(heard.body["share"]["expires_at"], expires_at);
    assert_eq!(section_names(&heard), ["Verse", "Chorus"]);
}

#[tokio::test]
async fn an_edit_is_validated_like_a_create() {
    let s = setup().await;
    let (id, _) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let path = format!("/api/v1/projects/{}/shares/{id}", s.project);

    let past = s
        .app
        .send(request(
            "PUT",
            &path,
            Some(&s.cookie),
            Some(json!({"label": "", "expires_at": now_ms() - 60_000,
                        "allow_comments": true, "allow_downloads": false})),
        ))
        .await;

    assert_eq!(past.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(past.body["error"]["code"], "invalid_share");
}

#[tokio::test]
async fn an_expired_link_keeps_its_expiry_when_only_other_settings_change() {
    let s = setup().await;
    let (id, _) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let expired_at = now_ms() - 1000;
    sqlx::query("UPDATE share_links SET expires_at = $1")
        .bind(expired_at)
        .execute(s.app.db().pool())
        .await
        .unwrap();

    let edited = s
        .app
        .send(request(
            "PUT",
            &format!("/api/v1/projects/{}/shares/{id}", s.project),
            Some(&s.cookie),
            Some(json!({"label": "old", "expires_at": expired_at,
                        "allow_comments": false, "allow_downloads": false})),
        ))
        .await;

    assert_eq!(edited.status, StatusCode::OK);
    assert_eq!(edited.body["share"]["status"], "expired");
}

#[tokio::test]
async fn revoking_takes_effect_at_once_is_permanent_and_idempotent() {
    let s = setup().await;
    let (id, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    post_comment(&s.app, &token, comment_body(3)).await;
    assert_eq!(listen(&s.app, &token).await.status, StatusCode::OK);

    assert_eq!(
        revoke(&s.app, &s.cookie, &s.project, &id).await.status,
        StatusCode::NO_CONTENT
    );

    let heard = listen(&s.app, &token).await;
    assert_eq!(heard.status, StatusCode::NOT_FOUND);
    assert_eq!(heard.body["error"]["code"], "not_found");
    let comments = owner_comments(&s.app, &s.cookie, &s.project).await;
    assert_eq!(comments.body["comments"].as_array().unwrap().len(), 1);
    assert_eq!(
        revoke(&s.app, &s.cookie, &s.project, &id).await.status,
        StatusCode::NO_CONTENT
    );
    let edit = s
        .app
        .send(request(
            "PUT",
            &format!("/api/v1/projects/{}/shares/{id}", s.project),
            Some(&s.cookie),
            Some(json!({"label": "", "expires_at": null,
                        "allow_comments": true, "allow_downloads": true})),
        ))
        .await;
    assert_eq!(edit.status, StatusCode::NOT_FOUND);
    assert_eq!(edit.body["error"]["code"], "not_found");
}

#[tokio::test]
async fn another_users_links_cannot_be_listed_edited_or_revoked() {
    let s = setup().await;
    let (id, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let other = s.app.cookie_for("other@example.com").await;
    let base = format!("/api/v1/projects/{}/shares", s.project);

    let listed = s.app.send(request("GET", &base, Some(&other), None)).await;
    let edited = s
        .app
        .send(request(
            "PUT",
            &format!("{base}/{id}"),
            Some(&other),
            Some(json!({"label": "mine now", "expires_at": null,
                        "allow_comments": true, "allow_downloads": true})),
        ))
        .await;
    let revoked = revoke(&s.app, &other, &s.project, &id).await;

    for response in [&listed, &edited, &revoked] {
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert_eq!(response.body["error"]["code"], "not_found");
    }
    assert_eq!(listen(&s.app, &token).await.status, StatusCode::OK);
}

#[tokio::test]
async fn turning_comments_off_refuses_the_next_comment() {
    let s = setup().await;
    let (id, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    assert_eq!(
        post_comment(&s.app, &token, comment_body(3)).await.status,
        StatusCode::CREATED
    );

    s.app
        .send(request(
            "PUT",
            &format!("/api/v1/projects/{}/shares/{id}", s.project),
            Some(&s.cookie),
            Some(json!({"label": "", "expires_at": null,
                        "allow_comments": false, "allow_downloads": false})),
        ))
        .await;

    let refused = post_comment(&s.app, &token, comment_body(3)).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    assert_eq!(count(&s.app, "share_comments").await, 1);
}

#[tokio::test]
async fn share_routes_need_a_session() {
    let s = setup().await;
    let (id, _) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let base = format!("/api/v1/projects/{}", s.project);
    let calls = [
        ("GET", format!("{base}/shares")),
        ("POST", format!("{base}/shares")),
        ("PUT", format!("{base}/shares/{id}")),
        ("DELETE", format!("{base}/shares/{id}")),
        ("GET", format!("{base}/comments")),
        ("PUT", format!("{base}/comments/c1")),
        ("DELETE", format!("{base}/comments/c1")),
    ];
    for (method, path) in calls {
        let response = s
            .app
            .send(request(method, &path, None, Some(json!({}))))
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{method} {path}");
        assert_eq!(response.body["error"]["code"], "unauthenticated");
    }
}

#[tokio::test]
async fn an_active_link_does_not_make_the_project_visible_to_another_user() {
    let s = setup().await;
    make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let other = s.app.cookie_for("other@example.com").await;
    let path = format!("/api/v1/projects/{}", s.project);

    let open = s.app.send(request("GET", &path, Some(&other), None)).await;
    let never = s
        .app
        .send(request(
            "GET",
            "/api/v1/projects/never-used",
            Some(&other),
            None,
        ))
        .await;

    assert_eq!(open.status, StatusCode::NOT_FOUND);
    assert_eq!(open.body, never.body);
}

#[tokio::test]
async fn deleting_a_shared_project_removes_links_and_comments() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, snapshot_body()).await;
    post_comment(&s.app, &token, comment_body(3)).await;
    assert_eq!(count(&s.app, "share_comments").await, 1);

    let deleted = s
        .app
        .send(request(
            "DELETE",
            &format!("/api/v1/projects/{}", s.project),
            Some(&s.cookie),
            None,
        ))
        .await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    let heard = listen(&s.app, &token).await;
    assert_eq!(heard.status, StatusCode::NOT_FOUND);
    assert_eq!(heard.body["error"]["code"], "not_found");
    assert_eq!(count(&s.app, "share_links").await, 0);
    assert_eq!(count(&s.app, "share_comments").await, 0);
}

#[tokio::test]
async fn owner_comments_are_ordered_by_position_then_time_with_their_link_details() {
    let s = setup().await;
    let (share_id, token) = make_share(
        &s.app,
        &s.cookie,
        &s.project,
        json!({"mode": "live", "expires_at": null, "allow_comments": true,
               "allow_downloads": false, "label": "Band"}),
    )
    .await;
    post_comment(&s.app, &token, comment_body(40)).await;
    post_comment(&s.app, &token, comment_body(2)).await;
    post_comment(&s.app, &token, comment_body(2)).await;

    let listed = owner_comments(&s.app, &s.cookie, &s.project).await;

    assert_eq!(listed.status, StatusCode::OK);
    let comments = listed.body["comments"].as_array().unwrap();
    let steps: Vec<i64> = comments
        .iter()
        .map(|c| c["at_step"].as_i64().unwrap())
        .collect();
    assert_eq!(steps, [2, 2, 40]);
    let first = &comments[0];
    assert_eq!(first["share_id"], share_id);
    assert_eq!(first["share_label"], "Band");
    assert_eq!(first["token_prefix"], token[..6]);
    assert_eq!(first["name"], "Sam");
    assert_eq!(first["body"], "Love this lift");
    assert_eq!(first["section_id"], "sec-verse");
    assert_eq!(first["section_name"], "Verse");
    assert_eq!(first["project_revision"], 1);
    assert_eq!(first["resolved_at"], Value::Null);
    assert!(first["created_at"].as_i64().unwrap() > 0);
    assert_eq!(comments[2]["section_name"], "Chorus");
}

#[tokio::test]
async fn resolving_and_reopening_a_comment() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    post_comment(&s.app, &token, comment_body(3)).await;
    let comment_id = owner_comments(&s.app, &s.cookie, &s.project).await.body["comments"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("/api/v1/projects/{}/comments/{comment_id}", s.project);

    let resolved = s
        .app
        .send(request(
            "PUT",
            &path,
            Some(&s.cookie),
            Some(json!({"resolved": true})),
        ))
        .await;
    assert_eq!(resolved.status, StatusCode::OK);
    assert!(resolved.body["comment"]["resolved_at"].is_i64());
    let listed = owner_comments(&s.app, &s.cookie, &s.project).await;
    assert!(listed.body["comments"][0]["resolved_at"].is_i64());

    let reopened = s
        .app
        .send(request(
            "PUT",
            &path,
            Some(&s.cookie),
            Some(json!({"resolved": false})),
        ))
        .await;
    assert_eq!(reopened.status, StatusCode::OK);
    assert_eq!(reopened.body["comment"]["resolved_at"], Value::Null);

    let bad = s
        .app
        .send(request("PUT", &path, Some(&s.cookie), Some(json!({}))))
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn deleting_a_comment_is_permanent() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    post_comment(&s.app, &token, comment_body(3)).await;
    let comment_id = owner_comments(&s.app, &s.cookie, &s.project).await.body["comments"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("/api/v1/projects/{}/comments/{comment_id}", s.project);

    let deleted = s
        .app
        .send(request("DELETE", &path, Some(&s.cookie), None))
        .await;
    let again = s
        .app
        .send(request("DELETE", &path, Some(&s.cookie), None))
        .await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    assert_eq!(count(&s.app, "share_comments").await, 0);
}

#[tokio::test]
async fn comments_from_a_revoked_link_are_still_listed() {
    let s = setup().await;
    let (id, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    for step in [1, 2, 3] {
        post_comment(&s.app, &token, comment_body(step)).await;
    }

    revoke(&s.app, &s.cookie, &s.project, &id).await;

    let listed = owner_comments(&s.app, &s.cookie, &s.project).await;
    assert_eq!(listed.body["comments"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn another_users_comment_is_not_found_and_unchanged() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    post_comment(&s.app, &token, comment_body(3)).await;
    let comment_id = owner_comments(&s.app, &s.cookie, &s.project).await.body["comments"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let other = s.app.cookie_for("other@example.com").await;
    let base = format!("/api/v1/projects/{}/comments", s.project);

    let listed = s.app.send(request("GET", &base, Some(&other), None)).await;
    let resolved = s
        .app
        .send(request(
            "PUT",
            &format!("{base}/{comment_id}"),
            Some(&other),
            Some(json!({"resolved": true})),
        ))
        .await;
    let deleted = s
        .app
        .send(request(
            "DELETE",
            &format!("{base}/{comment_id}"),
            Some(&other),
            None,
        ))
        .await;

    for response in [&listed, &resolved, &deleted] {
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert_eq!(response.body["error"]["code"], "not_found");
    }
    let mine = owner_comments(&s.app, &s.cookie, &s.project).await;
    assert_eq!(mine.body["comments"].as_array().unwrap().len(), 1);
    assert_eq!(mine.body["comments"][0]["resolved_at"], Value::Null);
}

#[tokio::test]
async fn a_second_project_gets_its_own_links_and_comments() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    post_comment(&s.app, &token, comment_body(3)).await;
    let second = create_project(&s.app, &s.cookie, sectioned_song("Other")).await;

    let shares = s
        .app
        .send(request(
            "GET",
            &format!("/api/v1/projects/{second}/shares"),
            Some(&s.cookie),
            None,
        ))
        .await;
    let comments = owner_comments(&s.app, &s.cookie, &second).await;

    assert_eq!(shares.body["shares"].as_array().unwrap().len(), 0);
    assert_eq!(comments.body["comments"].as_array().unwrap().len(), 0);
}
