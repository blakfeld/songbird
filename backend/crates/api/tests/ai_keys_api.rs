//! The key-management routes: saving, removing, choosing the active provider, and the rules
//! around them (format, live check, throttle, availability).

mod common;

use std::sync::Arc;

use api::ai_access::{AiAccess, MockUserProviders};
use api::config::MASTER_KEYS;
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::app::{request, Response, TestApp};
use serde_json::{json, Value};
use sqlx::Row;

const KEYRING: &str = "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ANTHROPIC_KEY: &str = "sk-ant-test-0000000000ok";
const OPENAI_KEY: &str = "sk-proj-test-0000000000ok";

async fn per_user_app() -> TestApp {
    TestApp::with_state(&[(MASTER_KEYS, KEYRING)], |state| {
        state.ai = AiAccess::PerUser(Arc::new(MockUserProviders));
    })
    .await
}

async fn shared_app(extra: &[(&str, &str)]) -> TestApp {
    TestApp::with_state(extra, |state| {
        state.shared_key_checker = Arc::new(MockUserProviders);
    })
    .await
}

async fn call(
    app: &TestApp,
    method: &str,
    uri: &str,
    cookie: &str,
    body: Option<Value>,
) -> Response {
    app.send(request(method, uri, Some(cookie), body)).await
}

async fn save(app: &TestApp, cookie: &str, provider: &str, key: &str) -> Response {
    call(
        app,
        "PUT",
        &format!("/api/v1/account/ai-keys/{provider}"),
        cookie,
        Some(json!({"key": key})),
    )
    .await
}

async fn save_raw(app: &TestApp, cookie: &str, provider: &str, raw: &str) -> Response {
    app.send(
        Request::put(format!("/api/v1/account/ai-keys/{provider}"))
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(raw.to_string()))
            .unwrap(),
    )
    .await
}

async fn summary(app: &TestApp, cookie: &str) -> Response {
    call(app, "GET", "/api/v1/account/ai-keys", cookie, None).await
}

fn listed(response: &Response) -> Vec<(String, String)> {
    response.body["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| {
            (
                k["provider"].as_str().unwrap().to_string(),
                k["last4"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn no_store(response: &Response) -> bool {
    response.headers[header::CACHE_CONTROL] == "no-store"
}

async fn stored_rows(app: &TestApp) -> i64 {
    sqlx::query("SELECT CAST(COUNT(*) AS BIGINT) FROM user_api_keys")
        .fetch_one(app.db().pool())
        .await
        .unwrap()
        .get(0)
}

#[tokio::test]
async fn a_new_user_has_an_empty_summary_that_says_keys_are_required() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = summary(&app, &cookie).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        response.body,
        json!({"keys_required": true, "active_provider": null, "keys": []})
    );
}

#[tokio::test]
async fn every_key_route_requires_a_session() {
    let app = per_user_app().await;
    for (method, uri, body) in [
        ("GET", "/api/v1/account/ai-keys", None),
        (
            "PUT",
            "/api/v1/account/ai-keys/anthropic",
            Some(json!({"key": ANTHROPIC_KEY})),
        ),
        ("DELETE", "/api/v1/account/ai-keys/anthropic", None),
        (
            "PUT",
            "/api/v1/account/ai-provider",
            Some(json!({"provider": "anthropic"})),
        ),
    ] {
        let response = app.send(request(method, uri, None, body)).await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(response.body["error"]["code"], "unauthenticated");
    }
}

#[tokio::test]
async fn saving_returns_the_summary_with_only_the_last_four_and_makes_the_first_key_active() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;
    assert_eq!(response.status, StatusCode::OK, "{:?}", response.body);
    assert!(no_store(&response));
    assert_eq!(
        listed(&response),
        [("anthropic".to_string(), "00ok".to_string())]
    );
    assert_eq!(response.body["active_provider"], "anthropic");
    assert_eq!(response.body["keys_required"], true);
    assert!(response.body["keys"][0]["updated_at"].is_i64());
    let text = response.body.to_string();
    assert!(!text.contains("sk-ant"), "{text}");

    let again = summary(&app, &cookie).await;
    assert_eq!(again.body, response.body);
}

#[tokio::test]
async fn both_providers_can_be_stored_and_replacing_keeps_the_active_choice() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;
    let both = save(&app, &cookie, "openai", OPENAI_KEY).await;
    assert_eq!(listed(&both).len(), 2);
    assert_eq!(both.body["active_provider"], "anthropic");

    let replaced = save(&app, &cookie, "anthropic", "sk-ant-test-replacement-wxyz").await;
    assert_eq!(listed(&replaced)[0], ("anthropic".into(), "wxyz".into()));
    assert_eq!(replaced.body["active_provider"], "anthropic");
    assert_eq!(stored_rows(&app).await, 2);
}

#[tokio::test]
async fn users_only_see_their_own_keys() {
    let app = per_user_app().await;
    let ana = app.cookie_for("ana@example.com").await;
    let bo = app.cookie_for("bo@example.com").await;
    save(&app, &ana, "anthropic", ANTHROPIC_KEY).await;
    assert!(listed(&summary(&app, &bo).await).is_empty());
}

#[tokio::test]
async fn the_database_holds_no_part_of_the_key_but_its_last_four() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let key = "sk-ant-sentinel-SECRETVALUE1234";
    save(&app, &cookie, "anthropic", key).await;
    let row = sqlx::query("SELECT key_version, nonce, ciphertext, last4 FROM user_api_keys")
        .fetch_one(app.db().pool())
        .await
        .unwrap();
    for i in 0..3 {
        let column: String = row.get(i);
        assert!(
            !column.contains("sentinel") && !column.contains("SECRET"),
            "{column}"
        );
    }
    assert_eq!(row.get::<String, _>(3), "1234");
}

#[tokio::test]
async fn malformed_keys_get_422_and_nothing_is_stored() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let long = format!("sk-ant-{}", "a".repeat(260));
    for (provider, key) in [
        ("anthropic", "sk-ant-short"),
        ("anthropic", "sk-proj-not-an-anthropic-key-1234"),
        ("openai", "sk-ant-this-is-an-anthropic-key-1234"),
        ("openai", "pk-not-an-openai-key-0000000000"),
        ("anthropic", "sk-ant-has spaces in it 0000000000"),
        (
            "anthropic",
            "sk-ant-unicode-\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}00000",
        ),
        ("anthropic", long.as_str()),
    ] {
        let response = save(&app, &cookie, provider, key).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{key}");
        assert_eq!(response.body["error"]["code"], "invalid_api_key_format");
        assert!(no_store(&response));
        assert!(!response.body.to_string().contains("sk-"), "echoed the key");
    }
    assert_eq!(stored_rows(&app).await, 0);
}

#[tokio::test]
async fn surrounding_whitespace_is_trimmed_before_the_check() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = save(&app, &cookie, "anthropic", &format!("  {ANTHROPIC_KEY}\n")).await;
    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn a_key_the_provider_rejects_is_422_and_not_stored() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = save(&app, &cookie, "anthropic", "sk-ant-test-0000-rejected").await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.body["error"]["code"], "api_key_rejected");
    assert!(response.body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Anthropic"));
    assert_eq!(stored_rows(&app).await, 0);
}

#[tokio::test]
async fn an_unreachable_provider_is_502_and_nothing_is_stored() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = save(&app, &cookie, "openai", "sk-proj-test-0000-unreachable").await;
    assert_eq!(response.status, StatusCode::BAD_GATEWAY);
    assert_eq!(response.body["error"]["code"], "provider_unreachable");
    assert_eq!(stored_rows(&app).await, 0);
}

#[tokio::test]
async fn a_revoked_looking_key_still_saves_because_only_the_check_decides() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = save(&app, &cookie, "anthropic", "sk-ant-test-0000-revoked").await;
    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn bad_bodies_get_the_fixed_invalid_json_error_without_quoting_the_input() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    for raw in [
        "not json at all SENTINEL-sk-ant-0000000000",
        r#"{"key": 12345678901234567890123}"#,
        r#"{"key": "sk-ant-SENTINEL-0000000000000", "extra": true}"#,
        r#"{"apikey": "sk-ant-SENTINEL-0000000000000"}"#,
        r#"{"key": ["sk-ant-SENTINEL-0000000000000"]}"#,
        "",
    ] {
        let response = save_raw(&app, &cookie, "anthropic", raw).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{raw}");
        assert_eq!(response.body["error"]["code"], "invalid_json");
        let text = response.body.to_string();
        assert!(
            !text.contains("SENTINEL") && !text.contains("1234567"),
            "{text}"
        );
        assert!(no_store(&response));
    }
    assert_eq!(stored_rows(&app).await, 0);
}

#[tokio::test]
async fn an_unknown_provider_is_404_on_save_and_remove() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let put = save(&app, &cookie, "gemini", ANTHROPIC_KEY).await;
    assert_eq!(put.status, StatusCode::NOT_FOUND);
    assert_eq!(put.body["error"]["code"], "not_found");
    assert!(no_store(&put));
    let delete = call(
        &app,
        "DELETE",
        "/api/v1/account/ai-keys/gemini",
        &cookie,
        None,
    )
    .await;
    assert_eq!(delete.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn removing_is_idempotent_and_falls_back_to_the_other_key() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    let missing = call(
        &app,
        "DELETE",
        "/api/v1/account/ai-keys/openai",
        &cookie,
        None,
    )
    .await;
    assert_eq!(missing.status, StatusCode::OK);
    assert!(no_store(&missing));

    save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;
    save(&app, &cookie, "openai", OPENAI_KEY).await;
    let removed = call(
        &app,
        "DELETE",
        "/api/v1/account/ai-keys/anthropic",
        &cookie,
        None,
    )
    .await;
    assert_eq!(removed.status, StatusCode::OK);
    assert_eq!(removed.body["active_provider"], "openai");
    assert_eq!(listed(&removed).len(), 1);

    let last = call(
        &app,
        "DELETE",
        "/api/v1/account/ai-keys/openai",
        &cookie,
        None,
    )
    .await;
    assert_eq!(last.body["active_provider"], Value::Null);
    assert!(listed(&last).is_empty());
}

#[tokio::test]
async fn the_active_provider_can_be_switched_between_stored_keys_only() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;

    let without = call(
        &app,
        "PUT",
        "/api/v1/account/ai-provider",
        &cookie,
        Some(json!({"provider": "openai"})),
    )
    .await;
    assert_eq!(without.status, StatusCode::CONFLICT);
    assert_eq!(without.body["error"]["code"], "api_key_required");
    assert!(no_store(&without));

    save(&app, &cookie, "openai", OPENAI_KEY).await;
    let switched = call(
        &app,
        "PUT",
        "/api/v1/account/ai-provider",
        &cookie,
        Some(json!({"provider": "openai"})),
    )
    .await;
    assert_eq!(switched.status, StatusCode::OK);
    assert_eq!(switched.body["active_provider"], "openai");

    let unknown = call(
        &app,
        "PUT",
        "/api/v1/account/ai-provider",
        &cookie,
        Some(json!({"provider": "gemini"})),
    )
    .await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_eleventh_save_attempt_in_an_hour_is_429_and_every_attempt_counts() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    for _ in 0..10 {
        let response = save(&app, &cookie, "anthropic", "sk-ant-short").await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let throttled = save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;
    assert_eq!(throttled.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(throttled.body["error"]["code"], "too_many_requests");
    let retry: u64 = throttled.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=3601).contains(&retry), "{retry}");
    assert!(no_store(&throttled));
    assert_eq!(stored_rows(&app).await, 0);

    let other = app.cookie_for("bo@example.com").await;
    assert_eq!(
        save(&app, &other, "anthropic", ANTHROPIC_KEY).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn reads_removals_and_provider_choice_are_not_throttled_by_saves() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;
    for _ in 0..12 {
        assert_eq!(summary(&app, &cookie).await.status, StatusCode::OK);
    }
}

#[tokio::test]
async fn development_without_a_keyring_answers_503_api_keys_unavailable_on_every_key_route() {
    let app = shared_app(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    for (method, uri, body) in [
        ("GET", "/api/v1/account/ai-keys", None),
        (
            "PUT",
            "/api/v1/account/ai-keys/anthropic",
            Some(json!({"key": ANTHROPIC_KEY})),
        ),
        ("DELETE", "/api/v1/account/ai-keys/anthropic", None),
        (
            "PUT",
            "/api/v1/account/ai-provider",
            Some(json!({"provider": "anthropic"})),
        ),
    ] {
        let response = call(&app, method, uri, &cookie, body).await;
        assert_eq!(
            response.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{method} {uri}"
        );
        assert_eq!(response.body["error"]["code"], "api_keys_unavailable");
        assert!(no_store(&response));
    }
}

#[tokio::test]
async fn a_shared_provider_with_a_keyring_manages_keys_but_reports_keys_not_required() {
    let app = shared_app(&[(MASTER_KEYS, KEYRING)]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let empty = summary(&app, &cookie).await;
    assert_eq!(empty.body["keys_required"], false);

    let saved = save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body["keys_required"], false);
    assert_eq!(listed(&saved).len(), 1);
}

#[tokio::test]
async fn a_rejected_replacement_leaves_the_old_key_in_place() {
    let app = per_user_app().await;
    let cookie = app.cookie_for("ana@example.com").await;
    save(&app, &cookie, "anthropic", ANTHROPIC_KEY).await;
    let before = summary(&app, &cookie).await;

    let rejected = save(
        &app,
        &cookie,
        "anthropic",
        "sk-ant-test-replacement-rejected",
    )
    .await;
    assert_eq!(rejected.status, StatusCode::UNPROCESSABLE_ENTITY);
    let unreachable = save(
        &app,
        &cookie,
        "anthropic",
        "sk-ant-test-replacement-unreachable",
    )
    .await;
    assert_eq!(unreachable.status, StatusCode::BAD_GATEWAY);

    let after = summary(&app, &cookie).await;
    assert_eq!(
        listed(&after),
        [("anthropic".to_string(), "00ok".to_string())]
    );
    assert_eq!(after.body, before.body);
}
