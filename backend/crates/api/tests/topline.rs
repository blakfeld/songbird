mod common;

use std::time::Duration;

use api::ai_access::AiAccess;
use api::config::GENERATION_TIMEOUT_SECS;
use api::provider::Providers;
use async_trait::async_trait;
use axum::http::StatusCode;
use common::app::{request, topline_body, Response, TestApp};
use music::ai::topline::{ToplineDraft, ToplineRequest};
use music::ai::{MockToplineProvider, ProviderError, ToplineProvider};
use serde_json::{json, Value};

const URI: &str = "/api/v1/songs/topline/generate";

async fn post(app: &TestApp, cookie: &str, body: Value) -> Response {
    app.send(request("POST", URI, Some(cookie), Some(body)))
        .await
}

/// Answers with a draft that skips the last syllable, which normalization can
/// never repair.
struct DropsASyllable;

#[async_trait]
impl ToplineProvider for DropsASyllable {
    async fn generate(&self, request: &ToplineRequest) -> Result<ToplineDraft, ProviderError> {
        let mut draft = MockToplineProvider.generate(request).await?;
        draft.lines.last_mut().unwrap().syllables.pop();
        Ok(draft)
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Slow;

#[async_trait]
impl ToplineProvider for Slow {
    async fn generate(&self, _: &ToplineRequest) -> Result<ToplineDraft, ProviderError> {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        unreachable!("the timeout fires first")
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

async fn app_over(provider: impl ToplineProvider + 'static, extra: &[(&str, &str)]) -> TestApp {
    TestApp::with_state(extra, |state| {
        state.ai = AiAccess::Shared(Providers::mock().with_topline(provider));
    })
    .await
}

#[tokio::test]
async fn a_chorus_topline_places_every_syllable_inside_the_range() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = post(&app, &cookie, topline_body()).await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["track_id"], "vocal");
    assert_eq!(
        response.body["range"],
        json!({"start_measure": 5, "end_measure": 8})
    );
    let notes = response.body["notes"].as_array().unwrap();
    let lyrics: Vec<&str> = notes.iter().filter_map(|n| n["lyric"].as_str()).collect();
    assert_eq!(lyrics.len(), 14);
    assert_eq!(lyrics[0], "hold");
    assert!(notes.iter().all(|n| n["step"].as_u64().unwrap() < 64));
    assert_eq!(response.body["prosody"]["stressed_syllables"], 8);
    assert_eq!(
        response.body["prosody"]["stressed_on_beat"],
        response.body["prosody"]["stressed_syllables"]
    );
}

#[tokio::test]
async fn the_mock_topline_is_repeatable() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let first = post(&app, &cookie, topline_body()).await;
    let second = post(&app, &cookie, topline_body()).await;
    assert_eq!(first.body, second.body);
}

async fn rejected(edit: impl FnOnce(&mut Value)) -> (Response, usize) {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let mut body = topline_body();
    edit(&mut body);
    let response = post(&app, &cookie, body).await;
    (response, app.calls())
}

#[tokio::test]
async fn each_rejected_request_is_422_with_its_code_and_no_provider_call() {
    type Edit = Box<dyn FnOnce(&mut Value)>;
    let cases: Vec<(&str, Edit)> = vec![
        (
            "invalid_track",
            Box::new(|b| b["track_id"] = json!("drums")),
        ),
        ("invalid_track", Box::new(|b| b["track_id"] = json!("nope"))),
        (
            "invalid_range",
            Box::new(|b| {
                b.as_object_mut().unwrap().remove("range");
            }),
        ),
        (
            "invalid_range",
            Box::new(|b| b["range"]["end_measure"] = json!(2)),
        ),
        ("invalid_lyrics", Box::new(|b| b["lines"] = json!([]))),
        (
            "invalid_lyrics",
            Box::new(|b| b["section_name"] = json!("")),
        ),
        (
            "invalid_lyrics",
            Box::new(|b| b["lines"][0]["syllables"][0]["text"] = json!("x".repeat(17))),
        ),
        (
            "lyrics_do_not_fit",
            Box::new(|b| {
                b["range"] = json!({"start_measure": 5, "end_measure": 5});
                b["lines"][0]["syllables"] =
                    json!(vec![json!({"text": "la", "stressed": false}); 17]);
            }),
        ),
        (
            "invalid_voice",
            Box::new(|b| {
                b["song"]["tracks"][0]["instrument"] = json!("bass");
                b["voice"] = json!("soprano");
            }),
        ),
        (
            "invalid_song",
            Box::new(|b| b["song"]["tempo_bpm"] = json!(5)),
        ),
        (
            "prompt_too_long",
            Box::new(|b| b["prompt"] = json!("word ".repeat(5000))),
        ),
    ];
    for (code, edit) in cases {
        let (response, calls) = rejected(edit).await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{code}");
        assert_eq!(response.body["error"]["code"], code);
        assert_eq!(calls, 0, "{code} reached the provider");
    }
}

#[tokio::test]
async fn an_empty_prompt_is_accepted() {
    let (response, calls) = rejected(|b| b["prompt"] = json!("")).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(calls, 1);
}

#[tokio::test]
async fn a_missing_prompt_is_accepted() {
    let (response, _) = rejected(|b| {
        b.as_object_mut().unwrap().remove("prompt");
    })
    .await;
    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn a_drums_target_gets_its_own_message_not_the_unknown_track_one() {
    let (drums, _) = rejected(|b| b["track_id"] = json!("drums")).await;
    let (unknown, _) = rejected(|b| b["track_id"] = json!("nope")).await;
    assert_eq!(drums.body["error"]["code"], "invalid_track");
    assert_eq!(unknown.body["error"]["code"], "invalid_track");
    assert!(drums.body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("melodic"));
    assert!(unknown.body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("no track"));
}

#[tokio::test]
async fn an_unknown_voice_is_400_invalid_json() {
    let (response, calls) = rejected(|b| b["voice"] = json!("bass")).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.body["error"]["code"], "invalid_json");
    assert_eq!(calls, 0);
}

#[tokio::test]
async fn a_provider_that_drops_a_syllable_twice_is_502() {
    let app = app_over(DropsASyllable, &[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = post(&app, &cookie, topline_body()).await;
    assert_eq!(response.status, StatusCode::BAD_GATEWAY);
    assert_eq!(response.body["error"]["code"], "generation_failed");
}

#[tokio::test]
async fn a_hanging_provider_is_504() {
    let app = app_over(Slow, &[(GENERATION_TIMEOUT_SECS, "1")]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = post(&app, &cookie, topline_body()).await;
    assert_eq!(response.status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(response.body["error"]["code"], "generation_timeout");
}

#[tokio::test]
async fn signing_in_is_required() {
    let app = TestApp::new(&[]).await;
    let response = app
        .send(request("POST", URI, None, Some(topline_body())))
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}
