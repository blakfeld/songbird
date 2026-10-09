//! Helpers for the share-link tests, so each scenario reads as the HTTP
//! exchange it checks.

use axum::body::Body;
use axum::http::{header, HeaderMap, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::app::{request, sectioned_song, Response, TestApp, ALLOWED_ORIGIN};

pub struct Raw {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub bytes: Vec<u8>,
}

pub async fn send_raw(app: &TestApp, request: Request<Body>) -> Raw {
    let response = app.router.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    Raw {
        status: parts.status,
        headers: parts.headers,
        bytes: body.collect().await.unwrap().to_bytes().to_vec(),
    }
}

pub fn listen_request(
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

pub async fn create_project(app: &TestApp, cookie: &str, song: Value) -> String {
    let response = app
        .send(request(
            "POST",
            "/api/v1/projects",
            Some(cookie),
            Some(json!({"song": song})),
        ))
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{:?}", response.body);
    response.body["project"]["id"].as_str().unwrap().to_string()
}

pub async fn sectioned_project(app: &TestApp, cookie: &str) -> String {
    create_project(app, cookie, sectioned_song("Late Train")).await
}

pub fn live_body() -> Value {
    json!({"mode": "live", "expires_at": null, "allow_comments": true, "allow_downloads": false})
}

pub async fn create_share(app: &TestApp, cookie: &str, project: &str, body: Value) -> Response {
    app.send(request(
        "POST",
        &format!("/api/v1/projects/{project}/shares"),
        Some(cookie),
        Some(body),
    ))
    .await
}

pub async fn make_share(
    app: &TestApp,
    cookie: &str,
    project: &str,
    body: Value,
) -> (String, String) {
    let response = create_share(app, cookie, project, body).await;
    assert_eq!(response.status, StatusCode::CREATED, "{:?}", response.body);
    (
        response.body["share"]["id"].as_str().unwrap().to_string(),
        response.body["token"].as_str().unwrap().to_string(),
    )
}

pub async fn listen(app: &TestApp, token: &str) -> Response {
    app.send(listen_request(
        "GET",
        &format!("/api/v1/listen/{token}"),
        &[],
        None,
    ))
    .await
}

pub async fn post_comment(app: &TestApp, token: &str, body: Value) -> Response {
    post_comment_from(app, token, body, &[]).await
}

pub async fn post_comment_from(
    app: &TestApp,
    token: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> Response {
    app.send(listen_request(
        "POST",
        &format!("/api/v1/listen/{token}/comments"),
        headers,
        Some(body),
    ))
    .await
}

pub fn comment_body(at_step: i64) -> Value {
    json!({"name": "Sam", "body": "Love this lift", "at_step": at_step})
}

pub async fn owner_comments(app: &TestApp, cookie: &str, project: &str) -> Response {
    app.send(request(
        "GET",
        &format!("/api/v1/projects/{project}/comments"),
        Some(cookie),
        None,
    ))
    .await
}

pub async fn revoke(app: &TestApp, cookie: &str, project: &str, share: &str) -> Response {
    app.send(request(
        "DELETE",
        &format!("/api/v1/projects/{project}/shares/{share}"),
        Some(cookie),
        None,
    ))
    .await
}

pub async fn count(app: &TestApp, table: &str) -> i64 {
    use sqlx::Row;
    sqlx::query(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(app.db().pool())
        .await
        .unwrap()
        .get(0)
}

/// Saves are refused within a second of the last one, so tests that save twice
/// move the last-save time back instead of sleeping.
pub async fn age_saves(app: &TestApp) {
    sqlx::query("UPDATE projects SET updated_at = updated_at - 5000")
        .execute(app.db().pool())
        .await
        .unwrap();
}

pub fn allowed_origin() -> (&'static str, &'static str) {
    ("origin", ALLOWED_ORIGIN)
}
