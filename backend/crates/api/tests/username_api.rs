mod common;

use axum::http::{header, StatusCode};
use common::app::{request, TestApp, ALLOWED_ORIGIN};
use common::share::commenter_cookie;
use serde_json::{json, Value};

async fn put_username(
    app: &TestApp,
    cookie: Option<&str>,
    username: &str,
) -> common::app::Response {
    app.send(request(
        "PUT",
        "/api/v1/account/username",
        cookie,
        Some(json!({"username": username})),
    ))
    .await
}

async fn me(app: &TestApp, cookie: &str) -> Value {
    app.send(request("GET", "/api/v1/auth/me", Some(cookie), None))
        .await
        .body
}

#[tokio::test]
async fn setting_a_username_returns_the_me_body_and_me_reports_it() {
    let app = TestApp::new(&[]).await;
    let cookie = commenter_cookie(&app, "ana@example.com", None).await;
    assert_eq!(me(&app, &cookie).await["user"]["username"], Value::Null);

    let response = put_username(&app, Some(&cookie), "Ana_1").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["user"]["username"], "ana_1");
    assert_eq!(response.body["user"]["email"], "ana@example.com");
    assert_eq!(response.body, me(&app, &cookie).await);
}

#[tokio::test]
async fn a_username_can_be_changed_and_resending_the_same_one_succeeds() {
    let app = TestApp::new(&[]).await;
    let cookie = commenter_cookie(&app, "ana@example.com", None).await;

    assert_eq!(
        put_username(&app, Some(&cookie), "ana").await.status,
        StatusCode::OK
    );
    assert_eq!(
        put_username(&app, Some(&cookie), "ana").await.status,
        StatusCode::OK
    );
    let changed = put_username(&app, Some(&cookie), "ana-b").await;

    assert_eq!(changed.status, StatusCode::OK);
    assert_eq!(me(&app, &cookie).await["user"]["username"], "ana-b");
}

#[tokio::test]
async fn a_name_another_account_has_is_409_regardless_of_case() {
    let app = TestApp::new(&[]).await;
    let ana = commenter_cookie(&app, "ana@example.com", Some("ana")).await;
    let bo = commenter_cookie(&app, "bo@example.com", None).await;

    let taken = put_username(&app, Some(&bo), "ANA").await;

    assert_eq!(taken.status, StatusCode::CONFLICT);
    assert_eq!(taken.body["error"]["code"], "username_taken");
    assert_eq!(me(&app, &bo).await["user"]["username"], Value::Null);
    assert_eq!(me(&app, &ana).await["user"]["username"], "ana");
}

#[tokio::test]
async fn invalid_usernames_are_422_and_leave_the_username_unchanged() {
    let app = TestApp::new(&[]).await;
    let long = "a".repeat(31);
    let bodies = [
        json!({"username": "1ana!"}),
        json!({"username": "ab"}),
        json!({"username": "_ana"}),
        json!({"username": "ana b"}),
        json!({"username": ""}),
        json!({"username": "\u{e4}n\u{e4}"}),
        json!({"username": long}),
        json!({}),
        json!({"username": 5}),
        json!({"username": null}),
    ];

    // One user per case because every attempt counts toward the hourly limit.
    for (n, body) in bodies.iter().enumerate() {
        let keeper = format!("keeper{n}");
        let cookie = commenter_cookie(&app, &format!("u{n}@example.com"), Some(&keeper)).await;
        let response = app
            .send(request(
                "PUT",
                "/api/v1/account/username",
                Some(&cookie),
                Some(body.clone()),
            ))
            .await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(response.body["error"]["code"], "invalid_username", "{body}");
        assert_eq!(me(&app, &cookie).await["user"]["username"], keeper.as_str());
    }
}

#[tokio::test]
async fn two_users_claiming_one_name_at_once_get_one_200_and_one_409() {
    let app = TestApp::new(&[]).await;
    let ana = commenter_cookie(&app, "ana@example.com", None).await;
    let bo = commenter_cookie(&app, "bo@example.com", None).await;

    let (first, second) = tokio::join!(
        put_username(&app, Some(&ana), "sam"),
        put_username(&app, Some(&bo), "sam"),
    );

    let mut statuses = [first.status, second.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
}

#[tokio::test]
async fn the_sixth_change_in_an_hour_is_429_with_retry_after() {
    let app = TestApp::new(&[]).await;
    let cookie = commenter_cookie(&app, "ana@example.com", None).await;
    let other = commenter_cookie(&app, "bo@example.com", None).await;

    for n in 1..=5 {
        let response = put_username(&app, Some(&cookie), &format!("name-{n}")).await;
        assert_eq!(response.status, StatusCode::OK, "change {n}");
    }
    let limited = put_username(&app, Some(&cookie), "name-6").await;

    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.body["error"]["code"], "too_many_requests");
    assert!(limited.headers.contains_key(header::RETRY_AFTER));
    assert_eq!(me(&app, &cookie).await["user"]["username"], "name-5");
    assert_eq!(
        put_username(&app, Some(&other), "fresh").await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn setting_a_username_needs_a_session() {
    let app = TestApp::new(&[]).await;

    let response = put_username(&app, None, "ana").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.body["error"]["code"], "unauthenticated");
}

#[tokio::test]
async fn a_cross_site_username_change_is_403() {
    let app = TestApp::new(&[]).await;
    let cookie = commenter_cookie(&app, "ana@example.com", None).await;

    let mut forged = request(
        "PUT",
        "/api/v1/account/username",
        Some(&cookie),
        Some(json!({"username": "ana"})),
    );
    forged
        .headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    let mut genuine = request(
        "PUT",
        "/api/v1/account/username",
        Some(&cookie),
        Some(json!({"username": "ana"})),
    );
    genuine
        .headers_mut()
        .insert("origin", ALLOWED_ORIGIN.parse().unwrap());

    assert_eq!(app.send(forged).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.send(genuine).await.status, StatusCode::OK);
}

#[tokio::test]
async fn refused_and_unchanged_attempts_do_not_use_up_the_hourly_budget() {
    let app = TestApp::new(&[]).await;
    commenter_cookie(&app, "ana@example.com", Some("taken")).await;
    let cookie = commenter_cookie(&app, "bo@example.com", Some("bobby")).await;

    for _ in 0..4 {
        assert_eq!(
            put_username(&app, Some(&cookie), "taken").await.status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            put_username(&app, Some(&cookie), "1bad!").await.status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            put_username(&app, Some(&cookie), "bobby").await.status,
            StatusCode::OK
        );
    }

    for n in 1..=5 {
        let response = put_username(&app, Some(&cookie), &format!("fresh-{n}")).await;
        assert_eq!(response.status, StatusCode::OK, "change {n}");
    }
    assert_eq!(
        put_username(&app, Some(&cookie), "fresh-6").await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
}
