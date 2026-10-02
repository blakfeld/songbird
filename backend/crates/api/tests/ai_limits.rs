mod common;

use std::sync::Arc;
use std::time::Duration;

use api::config::{AI_REQUESTS_PER_DAY, AI_REQUESTS_PER_MINUTE, MAX_CONCURRENT_GENERATIONS};
use api::provider::Providers;
use async_trait::async_trait;
use axum::http::{header, StatusCode};
use common::app::{request, song, TestApp};
use music::ai::{PatternProvider, ProviderError};
use music::{GenerateRequest, Instrument, PatternDraft};
use serde_json::{json, Value};

/// Every route that calls a provider. A new provider-calling route must be
/// added here, and mounting it outside the `ai` sub-router makes this fail.
fn ai_routes() -> Vec<(&'static str, Value)> {
    vec![
        (
            "/api/v1/patterns/generate",
            json!({"instrument": "drums", "prompt": "four on the floor", "measures": 4}),
        ),
        (
            "/api/v1/songs/tracks/generate",
            json!({"song": song("Late Train", 1), "track_id": "t0", "prompt": "busier"}),
        ),
        (
            "/api/v1/songs/chat",
            json!({"song": song("Late Train", 1), "messages": [{"role": "user", "content": "hello there"}]}),
        ),
    ]
}

async fn post(app: &TestApp, cookie: &str, uri: &str, body: &Value) -> common::app::Response {
    app.send(request("POST", uri, Some(cookie), Some(body.clone())))
        .await
}

#[tokio::test]
async fn every_ai_route_returns_429_once_the_daily_quota_is_spent_without_calling_the_provider() {
    for (uri, body) in ai_routes() {
        let app = TestApp::new(&[(AI_REQUESTS_PER_DAY, "2")]).await;
        let cookie = app.cookie_for("ana@example.com").await;

        for _ in 0..2 {
            let served = post(&app, &cookie, uri, &body).await;
            assert_eq!(served.status, StatusCode::OK, "{uri}");
        }
        let calls_before = app.calls();
        let refused = post(&app, &cookie, uri, &body).await;

        assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS, "{uri}");
        assert_eq!(refused.body["error"]["code"], "too_many_requests");
        let retry: u64 = refused.headers[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((1..=86_401).contains(&retry), "{retry}");
        assert_eq!(app.calls(), calls_before, "{uri} called the provider");
    }
}

#[tokio::test]
async fn the_daily_quota_is_shared_across_the_ai_routes() {
    let app = TestApp::new(&[(AI_REQUESTS_PER_DAY, "2")]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let routes = ai_routes();
    post(&app, &cookie, routes[0].0, &routes[0].1).await;
    post(&app, &cookie, routes[1].0, &routes[1].1).await;
    let refused = post(&app, &cookie, routes[2].0, &routes[2].1).await;
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_burst_over_the_per_minute_limit_gets_429_with_retry_after() {
    let app = TestApp::new(&[(AI_REQUESTS_PER_MINUTE, "3")]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let (uri, body) = &ai_routes()[0];

    for _ in 0..3 {
        let served = post(&app, &cookie, uri, body).await;
        assert_eq!(served.status, StatusCode::OK);
    }
    let refused = post(&app, &cookie, uri, body).await;

    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(refused.body["error"]["code"], "too_many_requests");
    let retry: u64 = refused.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=61).contains(&retry));
    assert_eq!(app.calls(), 3);
}

#[tokio::test]
async fn the_daily_quota_survives_an_app_rebuild_on_the_same_database() {
    let app = TestApp::new(&[(AI_REQUESTS_PER_DAY, "2")]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let (uri, body) = &ai_routes()[0];
    for _ in 0..2 {
        assert_eq!(post(&app, &cookie, uri, body).await.status, StatusCode::OK);
    }

    let restarted = app.rebuild(&[(AI_REQUESTS_PER_DAY, "2")]);
    let refused = post(&restarted, &cookie, uri, body).await;

    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(restarted.calls(), 0);
}

#[tokio::test]
async fn users_are_limited_separately() {
    let app = TestApp::new(&[(AI_REQUESTS_PER_DAY, "1"), (AI_REQUESTS_PER_MINUTE, "1")]).await;
    let ana = app.cookie_for("ana@example.com").await;
    let bo = app.cookie_for("bo@example.com").await;
    let (uri, body) = &ai_routes()[0];

    assert_eq!(post(&app, &ana, uri, body).await.status, StatusCode::OK);
    assert_eq!(
        post(&app, &ana, uri, body).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(post(&app, &bo, uri, body).await.status, StatusCode::OK);
}

#[tokio::test]
async fn non_ai_routes_are_not_metered() {
    let app = TestApp::new(&[(AI_REQUESTS_PER_DAY, "1"), (AI_REQUESTS_PER_MINUTE, "1")]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    for _ in 0..5 {
        let response = app
            .send(request("GET", "/api/v1/instruments", Some(&cookie), None))
            .await;
        assert_eq!(response.status, StatusCode::OK);
    }
}

struct BlockingPatterns(Arc<tokio::sync::Notify>);

#[async_trait]
impl PatternProvider for BlockingPatterns {
    async fn generate(
        &self,
        _: &GenerateRequest,
        _: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        self.0.notify_one();
        tokio::time::sleep(Duration::from_secs(3600)).await;
        unreachable!("the test aborts the request")
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[tokio::test]
async fn without_a_session_a_full_house_answers_401_not_503() {
    let started = Arc::new(tokio::sync::Notify::new());
    let held = started.clone();
    let app = Arc::new(
        TestApp::with_state(&[(MAX_CONCURRENT_GENERATIONS, "1")], |state| {
            state.providers = Providers::with_patterns(BlockingPatterns(held));
        })
        .await,
    );
    let cookie = app.cookie_for("ana@example.com").await;
    let (uri, body) = ai_routes().remove(0);

    let holder = {
        let app = app.clone();
        let (cookie, uri, body) = (cookie.clone(), uri.to_string(), body.clone());
        tokio::spawn(async move {
            app.send(request("POST", &uri, Some(&cookie), Some(body)))
                .await
        })
    };
    started.notified().await;

    let signed_in = post(&app, &cookie, uri, &body).await;
    assert_eq!(signed_in.status, StatusCode::SERVICE_UNAVAILABLE);
    for (uri, body) in ai_routes() {
        let anonymous = app.send(request("POST", uri, None, Some(body))).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    holder.abort();
}
