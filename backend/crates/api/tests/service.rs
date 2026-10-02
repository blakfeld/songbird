mod common;

use std::sync::Arc;

use api::config::{Config, AI_PROVIDER};
use api::error::ApiJson;
use api::provider::Providers;
use api::state::AppState;
use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::routing::post;
use axum::Router;
use http_body_util::BodyExt;
use music::InstrumentRegistry;
use serde_json::{json, Value};
use tower::ServiceExt;

const ALLOWED_ORIGIN: &str = "http://localhost:3000";

async fn state() -> (AppState, common::db::TestDb) {
    let db = common::db::test_db().await;
    let config = Config::from_lookup(|k| (k == AI_PROVIDER).then(|| "mock".to_string())).unwrap();
    let state = AppState {
        providers: Providers::mock(),
        instruments: InstrumentRegistry::builtin(),
        config: Arc::new(config),
        db: db.clone(),
    };
    (state, db)
}

async fn echo(ApiJson(value): ApiJson<Value>) -> axum::Json<Value> {
    axum::Json(value)
}

/// A route that just echoes lets body handling be tested independently of any
/// endpoint's own validation, while still wrapped in the production middleware.
async fn app_with_echo() -> Router {
    let (state, db) = state().await;
    let config = state.config.clone();
    let router = api::routes()
        .with_state(state)
        .route("/api/v1/echo", post(echo));
    db.keep_alive_with(api::middleware(router, &config))
}

async fn send(app: Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = app.oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (parts.status, parts.headers, bytes)
}

fn post_json(body: impl Into<Body>) -> Request<Body> {
    Request::post("/api/v1/echo")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.into())
        .unwrap()
}

fn error_of(bytes: &[u8]) -> Value {
    serde_json::from_slice::<Value>(bytes).unwrap()["error"].clone()
}

#[tokio::test]
async fn healthz_returns_ok() {
    let (status, _, body) = send(
        app().await,
        Request::get("/healthz").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(String::from_utf8(body).unwrap(), r#"{"status":"ok"}"#);
}

#[tokio::test]
async fn unknown_api_path_is_not_found_in_standard_shape() {
    let (status, _, body) = send(
        app().await,
        Request::get("/api/v1/nope").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let error = error_of(&body);
    assert_eq!(error["code"], "not_found");
    assert!(error["message"].as_str().is_some_and(|m| !m.is_empty()));
}

#[tokio::test]
async fn wrong_method_uses_standard_shape() {
    let (status, _, body) = send(
        app().await,
        Request::post("/healthz").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(error_of(&body)["code"], "method_not_allowed");
}

#[tokio::test]
async fn malformed_json_is_invalid_json() {
    for body in ["{not json", "", r#"{"a":"#] {
        let (status, _, bytes) = send(app_with_echo().await, post_json(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
        assert_eq!(error_of(&bytes)["code"], "invalid_json");
    }
}

#[tokio::test]
async fn missing_content_type_is_invalid_json() {
    let req = Request::post("/api/v1/echo")
        .body(Body::from(r#"{"a":1}"#))
        .unwrap();
    let (status, _, bytes) = send(app_with_echo().await, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_of(&bytes)["code"], "invalid_json");
}

#[tokio::test]
async fn valid_json_passes_through() {
    let (status, _, bytes) = send(app_with_echo().await, post_json(r#"{"a":1}"#)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"a": 1})
    );
}

/// `oneshot` does not add Content-Length, and the declared-length path is the
/// one a real client hits first, so tests must set it explicitly.
fn post_json_with_length(body: String) -> Request<Body> {
    Request::post("/api/v1/echo")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn one_mebibyte_body_with_content_length_is_rejected_with_json_413() {
    let big = format!(r#"{{"pad":"{}"}}"#, "a".repeat(1024 * 1024));
    let (status, headers, bytes) = send(app_with_echo().await, post_json_with_length(big)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    assert_eq!(error_of(&bytes)["code"], "payload_too_large");
}

#[tokio::test]
async fn oversize_body_without_content_length_is_rejected_with_413() {
    let big = format!(r#"{{"pad":"{}"}}"#, "a".repeat(1024 * 1024));
    // Chunked bodies carry no Content-Length, so the limit must trip while reading.
    let chunks: Vec<Result<Vec<u8>, std::convert::Infallible>> = big
        .as_bytes()
        .chunks(8192)
        .map(|c| Ok(c.to_vec()))
        .collect();
    let body = Body::from_stream(futures_util::stream::iter(chunks));
    let (status, _, bytes) = send(app_with_echo().await, post_json(body)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_of(&bytes)["code"], "payload_too_large");
}

#[tokio::test]
async fn body_just_under_the_limit_is_accepted() {
    let body = format!(r#"{{"pad":"{}"}}"#, "a".repeat(60 * 1024));
    let (status, _, _) = send(app_with_echo().await, post_json_with_length(body)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn allowed_origin_gets_cors_headers() {
    let req = Request::get("/healthz")
        .header(header::ORIGIN, ALLOWED_ORIGIN)
        .body(Body::empty())
        .unwrap();
    let (_, headers, _) = send(app().await, req).await;
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        ALLOWED_ORIGIN
    );
}

#[tokio::test]
async fn disallowed_origin_gets_no_cors_permission() {
    let req = Request::get("/healthz")
        .header(header::ORIGIN, "http://evil.example")
        .body(Body::empty())
        .unwrap();
    let (_, headers, _) = send(app().await, req).await;
    assert!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
}

#[tokio::test]
async fn preflight_from_allowed_origin_succeeds_and_from_other_does_not_grant() {
    let preflight = |origin: &str| {
        Request::builder()
            .method(Method::OPTIONS)
            .uri("/api/v1/echo")
            .header(header::ORIGIN, origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
            .body(Body::empty())
            .unwrap()
    };
    let (status, headers, _) = send(app_with_echo().await, preflight(ALLOWED_ORIGIN)).await;
    assert!(status.is_success());
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        ALLOWED_ORIGIN
    );
    let (_, headers, _) = send(app_with_echo().await, preflight("http://evil.example")).await;
    assert!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
}

#[tokio::test]
async fn oversize_rejection_still_carries_cors_headers() {
    let big = format!(r#"{{"pad":"{}"}}"#, "a".repeat(1024 * 1024));
    let mut req = post_json_with_length(big);
    req.headers_mut()
        .insert(header::ORIGIN, ALLOWED_ORIGIN.parse().unwrap());
    let (status, headers, bytes) = send(app_with_echo().await, req).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_of(&bytes)["code"], "payload_too_large");
    assert!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_some());
}

async fn app() -> Router {
    let (state, db) = state().await;
    db.keep_alive_with(api::app(state))
}
