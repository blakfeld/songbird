mod common;

use api::clock::now_ms;
use api::config::{
    COMMENTS_PER_ADDRESS_10M, COMMENTS_PER_ADDRESS_DAY, COMMENTS_PER_SHARE_DAY, TRUST_PROXY,
};
use axum::http::{header, StatusCode};
use common::app::{request, song, TestApp};
use common::share::*;
use serde_json::{json, Value};

const OWNER: &str = "owner@example.com";
const EVIL: (&str, &str) = ("origin", "https://evil.example");

struct Setup {
    app: TestApp,
    cookie: String,
    project: String,
}

async fn setup_with(config: &[(&str, &str)]) -> Setup {
    let app = TestApp::new(config).await;
    let cookie = app.cookie_for(OWNER).await;
    let project = sectioned_project(&app, &cookie).await;
    Setup {
        app,
        cookie,
        project,
    }
}

async fn setup() -> Setup {
    setup_with(&[]).await
}

fn downloads_body() -> Value {
    json!({"mode": "live", "expires_at": null, "allow_comments": true, "allow_downloads": true})
}

fn from_address(address: &str) -> [(&str, &str); 1] {
    [("x-forwarded-for", address)]
}

#[tokio::test]
async fn a_listener_without_an_account_gets_the_song_and_only_its_instruments() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, downloads_body()).await;

    let heard = listen(&s.app, &token).await;

    assert_eq!(heard.status, StatusCode::OK);
    assert_eq!(
        heard.body["share"],
        json!({"mode": "live", "allow_comments": true, "allow_downloads": true,
               "expires_at": null})
    );
    assert_eq!(heard.body["song"]["name"], "Late Train");
    assert_eq!(heard.body["song"]["lyrics"], "[Verse]\nla la");
    assert_eq!(heard.body["song"]["tracks"].as_array().unwrap().len(), 1);
    let instruments = heard.body["instruments"].as_array().unwrap();
    assert_eq!(instruments.len(), 1);
    assert_eq!(instruments[0]["id"], "drums");
    assert!(heard.body["shared_at"].as_i64().unwrap() > 0);
    assert_eq!(heard.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn the_projection_removes_chat_lyric_chat_and_section_notes() {
    let s = setup().await;
    let (_, live) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let (_, snapshot) = make_share(
        &s.app,
        &s.cookie,
        &s.project,
        json!({"mode": "snapshot", "expires_at": null, "allow_comments": true,
               "allow_downloads": false}),
    )
    .await;

    for token in [live, snapshot] {
        let heard = listen(&s.app, &token).await;
        let song = &heard.body["song"];
        assert!(song.get("chat").is_none());
        assert!(song.get("lyric_chat").is_none());
        for section in song["sections"].as_array().unwrap() {
            assert!(section.get("notes").is_none());
        }
        assert_eq!(song["sections"][1]["name"], "Chorus");
        assert!(!heard.body.to_string().contains("private"));
    }
}

#[tokio::test]
async fn the_response_has_nothing_about_the_owner_or_the_project() {
    let s = setup().await;
    let user = api::users::find_by_email(s.app.db(), OWNER)
        .await
        .unwrap()
        .unwrap();
    let (_, token) = make_share(
        &s.app,
        &s.cookie,
        &s.project,
        json!({"mode": "live", "expires_at": null, "allow_comments": true,
               "allow_downloads": true, "label": "Secret label"}),
    )
    .await;

    let heard = listen(&s.app, &token).await;

    let text = heard.body.to_string();
    for private in [OWNER, user.id.as_str(), s.project.as_str(), "Secret label"] {
        assert!(!text.contains(private), "{private} leaked in {text}");
    }
}

#[tokio::test]
async fn the_owners_session_changes_nothing() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let path = format!("/api/v1/listen/{token}");

    let anonymous = listen(&s.app, &token).await;
    let signed_in = s
        .app
        .send(request("GET", &path, Some(&s.cookie), None))
        .await;
    let bogus = s
        .app
        .send(request(
            "GET",
            &path,
            Some("songbird_session=nonsense"),
            None,
        ))
        .await;

    assert_eq!(anonymous.status, StatusCode::OK);
    assert_eq!(signed_in.body, anonymous.body);
    assert_eq!(bogus.status, StatusCode::OK);
    assert_eq!(bogus.body, anonymous.body);
}

#[tokio::test]
async fn every_unavailable_token_gets_the_same_404() {
    let s = setup().await;
    let (revoked_id, revoked) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    revoke(&s.app, &s.cookie, &s.project, &revoked_id).await;
    let (_, expired) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    sqlx::query("UPDATE share_links SET expires_at = $1 WHERE token_hash = $2")
        .bind(now_ms() - 1)
        .bind(api::token::hash_token(&expired))
        .execute(s.app.db().pool())
        .await
        .unwrap();
    let (_, hashed) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let never_issued = "A".repeat(43);
    let stored_hash = api::token::hash_token(&hashed);

    let baseline = listen(&s.app, &never_issued).await;
    assert_eq!(baseline.status, StatusCode::NOT_FOUND);
    assert_eq!(baseline.body["error"]["code"], "not_found");
    for token in [
        revoked.as_str(),
        expired.as_str(),
        stored_hash.as_str(),
        "abc",
        "",
    ] {
        let response = listen(&s.app, token).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{token}");
        assert_eq!(response.body, baseline.body, "{token}");
    }
}

#[tokio::test]
async fn an_expiry_takes_effect_when_the_clock_reaches_it() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    sqlx::query("UPDATE share_links SET expires_at = $1")
        .bind(now_ms() + 60_000)
        .execute(s.app.db().pool())
        .await
        .unwrap();
    assert_eq!(listen(&s.app, &token).await.status, StatusCode::OK);

    sqlx::query("UPDATE share_links SET expires_at = $1")
        .bind(now_ms())
        .execute(s.app.db().pool())
        .await
        .unwrap();
    assert_eq!(listen(&s.app, &token).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_live_link_reports_the_project_update_time_and_a_snapshot_its_creation_time() {
    let s = setup().await;
    let (_, live) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let heard = listen(&s.app, &live).await;
    let updated: i64 = sqlx::query_scalar("SELECT updated_at FROM projects")
        .fetch_one(s.app.db().pool())
        .await
        .unwrap();
    assert_eq!(heard.body["shared_at"], updated);

    let (_, snapshot) = make_share(
        &s.app,
        &s.cookie,
        &s.project,
        json!({"mode": "snapshot", "expires_at": null, "allow_comments": true,
               "allow_downloads": false}),
    )
    .await;
    let created: i64 =
        sqlx::query_scalar("SELECT created_at FROM share_links WHERE mode = 'snapshot'")
            .fetch_one(s.app.db().pool())
            .await
            .unwrap();
    assert_eq!(listen(&s.app, &snapshot).await.body["shared_at"], created);
}

#[tokio::test]
async fn the_listen_prefix_does_not_open_other_routes() {
    let s = setup().await;
    let shares = s
        .app
        .send(request(
            "GET",
            &format!("/api/v1/projects/{}/shares", s.project),
            None,
            None,
        ))
        .await;
    assert_eq!(shares.status, StatusCode::UNAUTHORIZED);
    assert_eq!(shares.body["error"]["code"], "unauthenticated");

    let projects = s
        .app
        .send(request("GET", "/api/v1/projects", None, None))
        .await;
    assert_eq!(projects.status, StatusCode::UNAUTHORIZED);
    let instruments = s
        .app
        .send(request("GET", "/api/v1/instruments", None, None))
        .await;
    assert_eq!(instruments.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn read_flood_from_one_address_gets_429_on_the_61st_request() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    for n in 1..=60 {
        let ok = listen(&s.app, &token).await;
        assert_eq!(ok.status, StatusCode::OK, "request {n}");
    }
    let limited = listen(&s.app, &token).await;

    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.body["error"]["code"], "too_many_requests");
    let retry: u64 = limited.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=61).contains(&retry));
}

#[tokio::test]
async fn reads_are_limited_per_address_and_the_limit_is_configurable() {
    let s = setup_with(&[
        ("SONGBIRD_SHARE_READS_PER_MINUTE", "2"),
        (TRUST_PROXY, "true"),
    ])
    .await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let get = |address: &'static str| {
        let app = &s.app;
        let path = format!("/api/v1/listen/{token}");
        async move {
            app.send(listen_request("GET", &path, &from_address(address), None))
                .await
        }
    };

    assert_eq!(get("198.51.100.1").await.status, StatusCode::OK);
    assert_eq!(get("198.51.100.1").await.status, StatusCode::OK);
    assert_eq!(
        get("198.51.100.1").await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(get("198.51.100.2").await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_midi_download_is_the_shared_song_as_a_midi_file_when_downloads_are_allowed() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, downloads_body()).await;

    let response = send_raw(
        &s.app,
        listen_request("GET", &format!("/api/v1/listen/{token}/midi"), &[], None),
    )
    .await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.headers[header::CONTENT_TYPE], "audio/midi");
    assert_eq!(
        response.headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"songbird-late-train-96bpm.mid\""
    );
    let parsed = midly::Smf::parse(&response.bytes).expect("a parseable MIDI file");
    assert!(!parsed.tracks.is_empty());
}

#[tokio::test]
async fn a_midi_download_matches_the_studio_export_byte_for_byte() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, downloads_body()).await;
    let shared = send_raw(
        &s.app,
        listen_request("GET", &format!("/api/v1/listen/{token}/midi"), &[], None),
    )
    .await;
    let served = listen(&s.app, &token).await;
    let mut song = served.body["song"].clone();
    // The studio sends its own copy of the song, so notes are present there.
    for section in song["sections"].as_array_mut().unwrap() {
        section["notes"] = json!("");
    }

    let exported = send_raw(
        &s.app,
        listen_request(
            "POST",
            "/api/v1/songs/export/midi",
            &[("cookie", &s.cookie)],
            Some(song),
        ),
    )
    .await;

    assert_eq!(exported.status, StatusCode::OK);
    assert_eq!(shared.bytes, exported.bytes);
    assert_eq!(
        shared.headers[header::CONTENT_DISPOSITION],
        exported.headers[header::CONTENT_DISPOSITION]
    );
}

#[tokio::test]
async fn a_midi_download_is_404_when_downloads_are_off_or_the_link_is_unavailable() {
    let s = setup().await;
    let (off_id, off) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let midi = |token: String| {
        let app = &s.app;
        async move {
            send_raw(
                app,
                listen_request("GET", &format!("/api/v1/listen/{token}/midi"), &[], None),
            )
            .await
        }
    };

    let refused = midi(off.clone()).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    let body: Value = serde_json::from_slice(&refused.bytes).unwrap();
    assert_eq!(body["error"]["code"], "not_found");

    revoke(&s.app, &s.cookie, &s.project, &off_id).await;
    assert_eq!(midi(off).await.status, StatusCode::NOT_FOUND);
    assert_eq!(midi("short".into()).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_comment_is_pinned_to_the_section_at_its_step_and_visible_to_the_owner() {
    let s = setup().await;
    let (share_id, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    let posted = post_comment(
        &s.app,
        &token,
        json!({"name": "Sam", "body": "Love this lift", "at_step": 40}),
    )
    .await;

    assert_eq!(posted.status, StatusCode::CREATED);
    let comment = &posted.body["comment"];
    assert!(!comment["id"].as_str().unwrap().is_empty());
    assert_eq!(comment["name"], "Sam");
    assert_eq!(comment["body"], "Love this lift");
    assert_eq!(comment["at_step"], 40);
    assert_eq!(comment["section_name"], "Chorus");
    assert!(comment["created_at"].as_i64().unwrap() > 0);
    assert!(comment.get("section_id").is_none());

    let listed = owner_comments(&s.app, &s.cookie, &s.project).await;
    let stored = &listed.body["comments"][0];
    assert_eq!(stored["id"], comment["id"]);
    assert_eq!(stored["share_id"], share_id);
    assert_eq!(stored["at_step"], 40);
    assert_eq!(stored["section_id"], "sec-chorus");
    assert_eq!(stored["section_name"], "Chorus");
    assert_eq!(stored["project_revision"], 1);
}

#[tokio::test]
async fn a_snapshot_comment_has_no_project_revision() {
    let s = setup().await;
    let (_, token) = make_share(
        &s.app,
        &s.cookie,
        &s.project,
        json!({"mode": "snapshot", "expires_at": null, "allow_comments": true,
               "allow_downloads": false}),
    )
    .await;

    post_comment(&s.app, &token, comment_body(3)).await;

    let listed = owner_comments(&s.app, &s.cookie, &s.project).await;
    assert_eq!(listed.body["comments"][0]["project_revision"], Value::Null);
}

#[tokio::test]
async fn positions_at_the_edges_of_the_song_are_accepted_and_just_past_it_is_not() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    for (step, expected) in [
        (0, StatusCode::CREATED),
        (31, StatusCode::CREATED),
        (64, StatusCode::CREATED),
        (65, StatusCode::UNPROCESSABLE_ENTITY),
        (-1, StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let response = post_comment(&s.app, &token, comment_body(step)).await;
        assert_eq!(response.status, expected, "step {step}");
        if expected != StatusCode::CREATED {
            assert_eq!(response.body["error"]["code"], "invalid_comment");
        }
    }
    let listed = owner_comments(&s.app, &s.cookie, &s.project).await;
    let names: Vec<&str> = listed.body["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["section_name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Verse", "Verse", "Chorus"]);
}

#[tokio::test]
async fn a_client_chosen_section_is_not_accepted() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let mut body = comment_body(3);
    body["section_name"] = json!("Admin");

    let response = post_comment(&s.app, &token, body).await;

    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.body["error"]["code"], "invalid_comment");
    assert_eq!(count(&s.app, "share_comments").await, 0);
}

#[tokio::test]
async fn comments_through_a_link_that_does_not_allow_them_are_404_and_store_nothing() {
    let s = setup().await;
    let (_, token) = make_share(
        &s.app,
        &s.cookie,
        &s.project,
        json!({"mode": "live", "expires_at": null, "allow_comments": false,
               "allow_downloads": false}),
    )
    .await;

    let response = post_comment(&s.app, &token, comment_body(3)).await;

    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.body["error"]["code"], "not_found");
    assert_eq!(count(&s.app, "share_comments").await, 0);
    let unknown = post_comment(&s.app, &"B".repeat(43), comment_body(3)).await;
    assert_eq!(unknown.body, response.body);
}

#[tokio::test]
async fn a_filled_honeypot_gets_a_201_and_stores_nothing() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let mut body = comment_body(40);
    body["website"] = json!("http://spam.example");

    let first = post_comment(&s.app, &token, body.clone()).await;
    let second = post_comment(&s.app, &token, body).await;

    assert_eq!(first.status, StatusCode::CREATED);
    assert_eq!(second.status, StatusCode::CREATED);
    let real = post_comment(&s.app, &token, comment_body(40)).await;
    let keys = |response: &common::app::Response| {
        let mut keys: Vec<String> = response.body["comment"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&first), keys(&real));
    assert_ne!(first.body["comment"]["id"], second.body["comment"]["id"]);
    assert_eq!(count(&s.app, "share_comments").await, 1);
    let empty_website = json!({"name": "Sam", "body": "ok", "at_step": 1, "website": ""});
    assert_eq!(
        post_comment(&s.app, &token, empty_website).await.status,
        StatusCode::CREATED
    );
    assert_eq!(count(&s.app, "share_comments").await, 2);
}

#[tokio::test]
async fn invalid_comments_are_422_invalid_comment_and_store_nothing() {
    let s = setup_with(&[(COMMENTS_PER_ADDRESS_10M, "100")]).await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let cases = [
        (
            "whitespace-only body",
            json!({"name": "Sam", "body": "   \n ", "at_step": 1}),
        ),
        (
            "empty name",
            json!({"name": "  ", "body": "hi", "at_step": 1}),
        ),
        (
            "long name",
            json!({"name": "x".repeat(41), "body": "hi", "at_step": 1}),
        ),
        (
            "bidi name",
            json!({"name": "Sam\u{202E}", "body": "hi", "at_step": 1}),
        ),
        (
            "bidi isolate body",
            json!({"name": "Sam", "body": "hi\u{2066}", "at_step": 1}),
        ),
        (
            "control in name",
            json!({"name": "Sam\u{0}", "body": "hi", "at_step": 1}),
        ),
        (
            "tab in body",
            json!({"name": "Sam", "body": "a\tb", "at_step": 1}),
        ),
        (
            "long body",
            json!({"name": "Sam", "body": "x".repeat(2001), "at_step": 1}),
        ),
        (
            "31 lines",
            json!({"name": "Sam", "body": "a\n".repeat(31), "at_step": 1}),
        ),
        (
            "fractional step",
            json!({"name": "Sam", "body": "hi", "at_step": 1.5}),
        ),
        (
            "string step",
            json!({"name": "Sam", "body": "hi", "at_step": "1"}),
        ),
        ("missing step", json!({"name": "Sam", "body": "hi"})),
        (
            "unknown field",
            json!({"name": "Sam", "body": "hi", "at_step": 1, "extra": 1}),
        ),
        ("not an object", json!([1, 2])),
    ];
    for (what, body) in cases {
        let response = post_comment(&s.app, &token, body).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{what}");
        assert_eq!(response.body["error"]["code"], "invalid_comment", "{what}");
    }
    assert_eq!(count(&s.app, "share_comments").await, 0);
}

#[tokio::test]
async fn limits_are_counted_in_characters_not_bytes() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let body = json!({"name": "é".repeat(40), "body": "ü".repeat(2000), "at_step": 1});

    let response = post_comment(&s.app, &token, body).await;

    assert_eq!(response.status, StatusCode::CREATED);
}

#[tokio::test]
async fn names_and_bodies_are_trimmed_and_markup_is_stored_as_received() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    let posted = post_comment(
        &s.app,
        &token,
        json!({"name": "  Sam \t  Jones ", "body": "  <img src=x onerror=alert(1)>\nline two \n",
               "at_step": 2}),
    )
    .await;

    assert_eq!(posted.status, StatusCode::CREATED);
    let listed = owner_comments(&s.app, &s.cookie, &s.project).await;
    assert_eq!(listed.body["comments"][0]["name"], "Sam Jones");
    assert_eq!(
        listed.body["comments"][0]["body"],
        "<img src=x onerror=alert(1)>\nline two"
    );
}

#[tokio::test]
async fn a_body_over_8_kib_is_413_payload_too_large() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let body = json!({"name": "Sam", "body": "x".repeat(9 * 1024), "at_step": 1});

    let response = post_comment(&s.app, &token, body).await;

    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.body["error"]["code"], "payload_too_large");
    assert_eq!(count(&s.app, "share_comments").await, 0);
}

#[tokio::test]
async fn a_cross_site_comment_is_403_and_stores_nothing() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    let refused = post_comment_from(&s.app, &token, comment_body(3), &[EVIL]).await;
    let allowed = post_comment_from(&s.app, &token, comment_body(3), &[allowed_origin()]).await;

    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(refused.body["error"]["code"], "forbidden");
    assert_eq!(allowed.status, StatusCode::CREATED);
    assert_eq!(count(&s.app, "share_comments").await, 1);
}

#[tokio::test]
async fn the_owners_session_is_ignored_when_commenting() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    let response = post_comment_from(
        &s.app,
        &token,
        comment_body(3),
        &[("cookie", s.cookie.as_str())],
    )
    .await;

    assert_eq!(response.status, StatusCode::CREATED);
}

#[tokio::test]
async fn a_sixth_comment_from_one_address_in_ten_minutes_is_429_and_not_stored() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    for n in 1..=5 {
        let ok = post_comment(&s.app, &token, comment_body(n)).await;
        assert_eq!(ok.status, StatusCode::CREATED, "comment {n}");
    }
    let limited = post_comment(&s.app, &token, comment_body(6)).await;

    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.body["error"]["code"], "too_many_requests");
    assert!(limited.headers.contains_key(header::RETRY_AFTER));
    assert_eq!(count(&s.app, "share_comments").await, 5);
}

#[tokio::test]
async fn other_addresses_are_unaffected_by_one_addresss_limit() {
    let s = setup_with(&[(TRUST_PROXY, "true"), (COMMENTS_PER_ADDRESS_10M, "1")]).await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let a = from_address("198.51.100.1");
    let b = from_address("198.51.100.2");

    assert_eq!(
        post_comment_from(&s.app, &token, comment_body(1), &a)
            .await
            .status,
        StatusCode::CREATED
    );
    assert_eq!(
        post_comment_from(&s.app, &token, comment_body(2), &a)
            .await
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        post_comment_from(&s.app, &token, comment_body(3), &b)
            .await
            .status,
        StatusCode::CREATED
    );
    assert_eq!(count(&s.app, "share_comments").await, 2);
}

#[tokio::test]
async fn refused_attempts_still_count_toward_the_address_limit() {
    let s = setup_with(&[(COMMENTS_PER_ADDRESS_10M, "3")]).await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    let invalid = json!({"name": "", "body": "", "at_step": -5});
    for _ in 0..2 {
        let response = post_comment(&s.app, &token, invalid.clone()).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let unknown_link = post_comment(&s.app, &"C".repeat(43), comment_body(1)).await;
    assert_eq!(unknown_link.status, StatusCode::NOT_FOUND);

    let limited = post_comment(&s.app, &token, comment_body(1)).await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(count(&s.app, "share_comments").await, 0);
}

#[tokio::test]
async fn the_daily_per_address_limit_applies_across_links() {
    let s = setup_with(&[(COMMENTS_PER_ADDRESS_DAY, "2")]).await;
    let (_, first) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let (_, second) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    assert_eq!(
        post_comment(&s.app, &first, comment_body(1)).await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        post_comment(&s.app, &second, comment_body(1)).await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        post_comment(&s.app, &first, comment_body(1)).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn the_per_link_daily_limit_applies_to_every_address() {
    let s = setup_with(&[(TRUST_PROXY, "true"), (COMMENTS_PER_SHARE_DAY, "2")]).await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let (_, other_link) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let from = |n: u8| format!("198.51.100.{n}");

    for n in 1..=2 {
        let address = from(n);
        let ok = post_comment_from(
            &s.app,
            &token,
            comment_body(1),
            &[("x-forwarded-for", address.as_str())],
        )
        .await;
        assert_eq!(ok.status, StatusCode::CREATED);
    }
    let address = from(3);
    let limited = post_comment_from(
        &s.app,
        &token,
        comment_body(1),
        &[("x-forwarded-for", address.as_str())],
    )
    .await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers.contains_key(header::RETRY_AFTER));
    let elsewhere = post_comment_from(
        &s.app,
        &other_link,
        comment_body(1),
        &[("x-forwarded-for", address.as_str())],
    )
    .await;
    assert_eq!(elsewhere.status, StatusCode::CREATED);
}

#[tokio::test]
async fn invalid_and_honeypot_posts_do_not_use_up_the_links_daily_budget() {
    let s = setup_with(&[
        (COMMENTS_PER_SHARE_DAY, "1"),
        (COMMENTS_PER_ADDRESS_10M, "100"),
    ])
    .await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;

    for _ in 0..3 {
        let invalid = json!({"name": "", "body": "x", "at_step": 1});
        let refused = post_comment(&s.app, &token, invalid).await;
        assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
        let mut trap = comment_body(1);
        trap["website"] = json!("http://spam.example");
        assert_eq!(
            post_comment(&s.app, &token, trap).await.status,
            StatusCode::CREATED
        );
    }

    assert_eq!(
        post_comment(&s.app, &token, comment_body(1)).await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        post_comment(&s.app, &token, comment_body(1)).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn a_comment_on_an_unsectioned_song_gets_the_implicit_section_name_and_no_id() {
    let s = setup().await;
    let mut unsectioned = song("Long", 1);
    unsectioned["measures"] = json!(40);
    unsectioned["tracks"][0]["clips"][0]["measures"] = json!(1);
    let project = create_project(&s.app, &s.cookie, unsectioned).await;
    let (_, token) = make_share(&s.app, &s.cookie, &project, live_body()).await;

    let early = post_comment(&s.app, &token, comment_body(0)).await;
    let late = post_comment(&s.app, &token, comment_body(32 * 16)).await;

    assert_eq!(early.status, StatusCode::CREATED, "{:?}", early.body);
    assert_eq!(early.body["comment"]["section_name"], "Song");
    assert_eq!(late.body["comment"]["section_name"], "Song 2");
    let stored = owner_comments(&s.app, &s.cookie, &project).await;
    let comments = stored.body["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 2);
    assert!(comments.iter().all(|c| c["section_id"].is_null()));
}

#[tokio::test]
async fn a_link_with_1000_comments_refuses_another_with_409_comment_limit() {
    let s = setup().await;
    let (share_id, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    let mut tx = s.app.db().pool().begin().await.unwrap();
    for n in 0..1000 {
        sqlx::query(
            "INSERT INTO share_comments (id, share_id, project_id, author_name, body, at_step, \
             created_at) VALUES ($1, $2, $3, 'Sam', 'hi', 0, $4)",
        )
        .bind(format!("c{n}"))
        .bind(&share_id)
        .bind(&s.project)
        .bind(n)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let refused = post_comment(&s.app, &token, comment_body(3)).await;

    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.body["error"]["code"], "comment_limit");
    assert_eq!(count(&s.app, "share_comments").await, 1000);
}

#[tokio::test]
async fn there_is_no_public_way_to_list_comments() {
    let s = setup().await;
    let (_, token) = make_share(&s.app, &s.cookie, &s.project, live_body()).await;
    post_comment(&s.app, &token, comment_body(3)).await;

    let served = listen(&s.app, &token).await;
    assert!(!served.body.to_string().contains("Love this lift"));
    let listing = s
        .app
        .send(listen_request(
            "GET",
            &format!("/api/v1/listen/{token}/comments"),
            &[],
            None,
        ))
        .await;
    assert_eq!(listing.status, StatusCode::METHOD_NOT_ALLOWED);
}
