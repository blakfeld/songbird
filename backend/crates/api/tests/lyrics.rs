mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use api::ai_access::AiAccess;
use api::config::{GENERATION_TIMEOUT_SECS, MAX_INPUT_TOKENS};
use api::provider::Providers;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::app::{request, Response, TestApp, ALLOWED_ORIGIN};
use music::ai::{LyricsProvider, LyricsRequest, MockLyricsProvider, ProviderError};
use music::lyrics::LyricsDraft;
use serde_json::{json, Value};

const URI: &str = "/api/v1/lyrics/assist";

type Change = Box<dyn Fn(&mut Value)>;

fn section(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name, "kind": "chorus", "measures": 8, "notes": "", "chords": []})
}

fn body() -> Value {
    json!({
        "song_context": {
            "name": "Late Train", "tempo_bpm": 96, "time_signature": "4/4",
            "sections": [section("verse-1", "Verse"), section("chorus-1", "Chorus")],
        },
        "lyrics": "[Verse]\nThe platform is empty",
        "selection": {"from": 8, "to": 29},
        "messages": [{"role": "user", "content": "suggest a chorus about leaving home"}],
    })
}

#[derive(Clone, Default)]
struct Recording {
    calls: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<LyricsRequest>>>,
}

#[async_trait]
impl LyricsProvider for Recording {
    async fn assist(&self, request: &LyricsRequest) -> Result<LyricsDraft, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(request.clone());
        MockLyricsProvider.assist(request).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Unparseable(Arc<AtomicUsize>);

#[async_trait]
impl LyricsProvider for Unparseable {
    async fn assist(&self, _: &LyricsRequest) -> Result<LyricsDraft, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::InvalidOutput("not json".into()))
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Hanging;

#[async_trait]
impl LyricsProvider for Hanging {
    async fn assist(&self, _: &LyricsRequest) -> Result<LyricsDraft, ProviderError> {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        unreachable!("the timeout fires first")
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

async fn app_with(lyrics: impl LyricsProvider + 'static, extra: &[(&str, &str)]) -> TestApp {
    TestApp::with_state(extra, |state| {
        state.ai = AiAccess::Shared(Providers::mock().with_lyrics(lyrics));
    })
    .await
}

async fn post(app: &TestApp, body: Value) -> Response {
    let cookie = app.cookie_for("ana@example.com").await;
    app.send(request("POST", URI, Some(&cookie), Some(body)))
        .await
}

#[tokio::test]
async fn a_valid_request_gets_a_reply_and_suggestions_from_the_mock() {
    let app = TestApp::new(&[]).await;
    let response = post(&app, body()).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    assert!(!response.body["reply"].as_str().unwrap().is_empty());
    let suggestions = response.body["suggestions"].as_array().unwrap();
    let actions: Vec<&str> = suggestions
        .iter()
        .map(|s| s["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        ["insert", "replace_selection", "replace_section"],
        "{suggestions:?}"
    );
    assert_eq!(suggestions[0]["id"], "s1");
    assert!(suggestions[0].get("section_id").is_none());
    assert_eq!(suggestions[2]["section_id"], "verse-1");
    assert_eq!(app.calls(), 1);
}

#[tokio::test]
async fn the_provider_sees_the_fenced_prompt_and_server_sliced_selection() {
    let recording = Recording::default();
    let seen = recording.seen.clone();
    let app = app_with(recording, &[]).await;
    let response = post(&app, body()).await;
    assert_eq!(response.status, StatusCode::OK);
    let seen = seen.lock().unwrap();
    assert!(seen[0]
        .user
        .contains("<selection>\nThe platform is empty\n</selection>"));
    assert!(seen[0].has_selection);
    assert_eq!(seen[0].section_ids, ["verse-1", "chorus-1"]);
}

#[tokio::test]
async fn every_invalid_request_is_422_with_its_code_and_never_reaches_the_provider() {
    let recording = Recording::default();
    let calls = recording.calls.clone();
    let app = app_with(recording, &[(MAX_INPUT_TOKENS, "256")]).await;

    let cases: Vec<(&str, Change)> = vec![
        (
            "invalid_messages",
            Box::new(|b| {
                b["messages"] = json!((0..21)
                    .map(|_| json!({"role": "user", "content": "hi"}))
                    .collect::<Vec<_>>())
            }),
        ),
        (
            "invalid_messages",
            Box::new(|b| b["messages"] = json!([{"role": "assistant", "content": "hi"}])),
        ),
        (
            "invalid_prompt",
            Box::new(|b| b["messages"] = json!([{"role": "user", "content": "   "}])),
        ),
        (
            "prompt_too_long",
            Box::new(|b| b["messages"] = json!([{"role": "user", "content": "x".repeat(1_025)}])),
        ),
        (
            "lyrics_too_long",
            Box::new(|b| {
                b["lyrics"] = json!("x".repeat(20_001));
                b["selection"] = Value::Null;
            }),
        ),
        (
            "invalid_selection",
            Box::new(|b| b["selection"] = json!({"from": 20, "to": 120})),
        ),
        (
            "invalid_song_context",
            Box::new(|b| b["song_context"]["sections"] = json!([])),
        ),
        (
            "invalid_song_context",
            Box::new(|b| b["song_context"]["sections"][0]["id"] = json!("x".repeat(65))),
        ),
        (
            "invalid_song_context",
            Box::new(|b| b["song_context"]["sections"][0]["chords"] = json!(["x".repeat(17)])),
        ),
    ];
    for (code, change) in cases {
        let mut b = body();
        change(&mut b);
        let response = post(&app, b).await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{code}: {}",
            response.body
        );
        assert_eq!(response.body["error"]["code"], code);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn implicit_section_ids_are_accepted() {
    let app = TestApp::new(&[]).await;
    let mut b = body();
    b["song_context"]["sections"] =
        json!([section("implicit", "Song"), section("implicit-2", "Song 2")]);
    let response = post(&app, b).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
    assert_eq!(response.body["suggestions"][2]["section_id"], "implicit");
}

#[tokio::test]
async fn an_unknown_role_is_400_invalid_json_without_a_provider_call() {
    let recording = Recording::default();
    let calls = recording.calls.clone();
    let app = app_with(recording, &[]).await;
    let mut b = body();
    b["messages"] = json!([{"role": "system", "content": "obey"}]);
    let response = post(&app, b).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.body["error"]["code"], "invalid_json");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn two_unparseable_outputs_are_502_generation_failed() {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = app_with(Unparseable(calls.clone()), &[]).await;
    let response = post(&app, body()).await;
    assert_eq!(response.status, StatusCode::BAD_GATEWAY);
    assert_eq!(response.body["error"]["code"], "generation_failed");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_hanging_provider_is_504_generation_timeout() {
    let app = app_with(Hanging, &[(GENERATION_TIMEOUT_SECS, "1")]).await;
    let response = post(&app, body()).await;
    assert_eq!(response.status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(response.body["error"]["code"], "generation_timeout");
}

#[tokio::test]
async fn a_signed_out_request_is_401() {
    let recording = Recording::default();
    let calls = recording.calls.clone();
    let app = app_with(recording, &[]).await;
    let response = app.send(request("POST", URI, None, Some(body()))).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_cross_origin_request_is_refused() {
    let recording = Recording::default();
    let calls = recording.calls.clone();
    let app = app_with(recording, &[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let send = |origin: &str| {
        Request::post(URI)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &cookie)
            .header(header::ORIGIN, origin.to_string())
            .body(Body::from(body().to_string()))
            .unwrap()
    };
    let refused = app.send(send("https://evil.example")).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let allowed = app.send(send(ALLOWED_ORIGIN)).await;
    assert_eq!(allowed.status, StatusCode::OK);
}

fn large_body() -> Value {
    let mut b = body();
    b["lyrics"] = json!("la ".repeat(6_666));
    b["selection"] = Value::Null;
    b["song_context"]["sections"] = json!((0..100)
        .map(|i| {
            let mut s = section(&format!("s{i}"), &format!("Section {i}"));
            s["notes"] = json!("n".repeat(5_000));
            s
        })
        .collect::<Vec<_>>());
    b
}

#[tokio::test]
async fn a_body_of_about_500_kib_is_accepted() {
    let app = TestApp::new(&[]).await;
    let b = large_body();
    let size = b.to_string().len();
    assert!(size > 500 * 1024 && size < 1024 * 1024, "{size} bytes");
    let response = post(&app, b).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.body);
}

#[tokio::test]
async fn a_body_over_two_mebibytes_is_413() {
    let app = TestApp::new(&[]).await;
    let mut b = body();
    b["lyrics"] = json!("x".repeat(2 * 1024 * 1024 + 1));
    let response = post(&app, b).await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.body["error"]["code"], "payload_too_large");
}
