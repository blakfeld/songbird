mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use api::config::{
    Config, AI_PROVIDER, GENERATION_TIMEOUT_SECS, MAX_CONTEXT_TOKENS, MAX_INPUT_TOKENS,
};
use api::provider::Providers;
use api::state::AppState;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use music::ai::{MockProvider, PatternProvider, ProviderError};
use music::{GenerateRequest, Instrument, InstrumentRegistry, PatternDraft};
use serde_json::{json, Value};
use tower::ServiceExt;

const GENERATE_URI: &str = "/api/v1/songs/tracks/generate";

/// Records every request so tests can assert what reached the provider.
#[derive(Clone, Default)]
struct Recording {
    seen: Arc<Mutex<Vec<GenerateRequest>>>,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl PatternProvider for Recording {
    async fn generate(
        &self,
        request: &GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(request.clone());
        MockProvider.generate(request, instrument).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Slow;

#[async_trait]
impl PatternProvider for Slow {
    async fn generate(
        &self,
        _: &GenerateRequest,
        _: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        unreachable!("the timeout fires first")
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

async fn app_with(
    provider: impl PatternProvider + 'static,
    extra: &[(&str, &str)],
) -> axum::Router {
    let db = common::db::test_db().await;
    let config = Config::from_lookup(|k| {
        if k == AI_PROVIDER {
            return Some("mock".into());
        }
        extra
            .iter()
            .find(|(n, _)| *n == k)
            .map(|(_, v)| v.to_string())
    })
    .unwrap();
    let router = api::app(AppState {
        providers: Providers::with_patterns(provider),
        instruments: InstrumentRegistry::builtin(),
        config: Arc::new(config),
        db: db.clone(),
    });
    db.keep_alive_with(router)
}

async fn call(app: axum::Router, req: Request<Body>) -> (StatusCode, Value) {
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn generate(app: axum::Router, body: Value) -> (StatusCode, Value) {
    let req = Request::post(GENERATE_URI)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    call(app, req).await
}

fn track(id: &str, name: &str, instrument: &str, loops: Value, clips: Value) -> Value {
    json!({
        "id": id, "name": name, "instrument": instrument, "volume_db": 0, "pan": 0,
        "muted": false, "soloed": false, "loops": loops, "clips": clips,
    })
}

fn song(measures: u32, tracks: Vec<Value>) -> Value {
    json!({
        "version": 2, "id": "song-1", "name": "Late Train", "tempo_bpm": 96,
        "time_signature": "4/4", "steps_per_measure": 16, "swing": 0,
        "measures": measures, "tracks": tracks,
    })
}

fn note(row: &str, step: u32, length: u32) -> Value {
    json!({"row_id": row, "step": step, "length_steps": length, "velocity": 100})
}

fn drums_and_empty_bass(measures: u32) -> Value {
    song(
        measures,
        vec![
            track(
                "t1",
                "Drums",
                "drums",
                json!([{"id": "l1", "name": "Beat", "measures": 1, "notes": [note("kick", 0, 1)]}]),
                json!([{"id": "c1", "loop_id": "l1", "start_measure": 1, "measures": measures.min(16)}]),
            ),
            track("t2", "Bass", "bass", json!([]), json!([])),
        ],
    )
}

fn body(song: Value, range: Option<(u32, u32)>) -> Value {
    let mut body = json!({"song": song, "track_id": "t2", "prompt": "driving eighth-note bass"});
    if let Some((start, end)) = range {
        body["range"] = json!({"start_measure": start, "end_measure": end});
    }
    body
}

fn bass_row_ids() -> Vec<String> {
    music::instruments::bass::BASS
        .row_list()
        .into_iter()
        .map(|r| r.id)
        .collect()
}

#[tokio::test]
async fn whole_song_generation_succeeds_within_the_song() {
    let (status, response) = generate(
        app_with(MockProvider, &[]).await,
        body(drums_and_empty_bass(8), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["track_id"], "t2");
    assert_eq!(
        response["range"],
        json!({"start_measure": 1, "end_measure": 8})
    );
    let rows = bass_row_ids();
    let notes = response["notes"].as_array().unwrap();
    assert!(!notes.is_empty());
    for n in notes {
        assert!(rows.contains(&n["row_id"].as_str().unwrap().to_string()));
        assert!(n["step"].as_u64().unwrap() + n["length_steps"].as_u64().unwrap() <= 128);
    }
    assert!(response.get("tempo_bpm").is_none());
}

#[tokio::test]
async fn range_generation_counts_steps_from_the_range_start() {
    let (status, response) = generate(
        app_with(MockProvider, &[]).await,
        body(drums_and_empty_bass(16), Some((5, 8))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        response["range"],
        json!({"start_measure": 5, "end_measure": 8})
    );
    for n in response["notes"].as_array().unwrap() {
        assert!(n["step"].as_u64().unwrap() + n["length_steps"].as_u64().unwrap() <= 64);
    }
}

#[tokio::test]
async fn the_mock_is_deterministic_for_track_generation() {
    let request = body(drums_and_empty_bass(8), Some((1, 4)));
    let (_, first) = generate(app_with(MockProvider, &[]).await, request.clone()).await;
    let (_, second) = generate(app_with(MockProvider, &[]).await, request).await;
    assert_eq!(first, second);
}

async fn rejected(request: Value) -> (StatusCode, Value, usize) {
    let provider = Recording::default();
    let calls = provider.calls.clone();
    let (status, response) = generate(app_with(provider, &[]).await, request).await;
    (
        status,
        response["error"]["code"].clone(),
        calls.load(Ordering::SeqCst),
    )
}

#[tokio::test]
async fn unknown_track_is_422_without_a_provider_call() {
    let mut request = body(drums_and_empty_bass(8), None);
    request["track_id"] = json!("nope");
    assert_eq!(
        rejected(request).await,
        (StatusCode::UNPROCESSABLE_ENTITY, json!("invalid_track"), 0)
    );
}

#[tokio::test]
async fn range_over_32_measures_is_422_without_a_provider_call() {
    assert_eq!(
        rejected(body(drums_and_empty_bass(64), Some((1, 40)))).await,
        (StatusCode::UNPROCESSABLE_ENTITY, json!("invalid_range"), 0)
    );
}

#[tokio::test]
async fn long_song_without_a_range_is_422() {
    assert_eq!(
        rejected(body(drums_and_empty_bass(48), None)).await,
        (StatusCode::UNPROCESSABLE_ENTITY, json!("invalid_range"), 0)
    );
}

#[tokio::test]
async fn range_past_measure_128_is_422() {
    assert_eq!(
        rejected(body(drums_and_empty_bass(8), Some((120, 129)))).await,
        (StatusCode::UNPROCESSABLE_ENTITY, json!("invalid_range"), 0)
    );
}

#[tokio::test]
async fn a_range_past_the_song_end_is_generated() {
    let mut one_measure = drums_and_empty_bass(1);
    one_measure["tracks"][0]["clips"][0]["measures"] = json!(1);
    let (status, response) = generate(
        app_with(MockProvider, &[]).await,
        body(one_measure, Some((1, 16))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        response["range"],
        json!({"start_measure": 1, "end_measure": 16})
    );
    let notes = response["notes"].as_array().unwrap();
    assert!(notes
        .iter()
        .all(|n| n["step"].as_u64().unwrap() + n["length_steps"].as_u64().unwrap() <= 256));
    assert!(
        notes.iter().any(|n| n["step"].as_u64().unwrap() >= 16),
        "notes cover more than measure 1"
    );
}

#[tokio::test]
async fn prompt_and_song_rules_apply_before_the_provider() {
    let mut request = body(drums_and_empty_bass(8), None);
    request["prompt"] = json!("  ");
    assert_eq!(
        rejected(request).await,
        (StatusCode::UNPROCESSABLE_ENTITY, json!("invalid_prompt"), 0)
    );

    let mut request = body(drums_and_empty_bass(8), None);
    request["song"]["tempo_bpm"] = json!(1000);
    assert_eq!(
        rejected(request).await,
        (StatusCode::UNPROCESSABLE_ENTITY, json!("invalid_song"), 0)
    );
}

#[tokio::test]
async fn a_hanging_provider_is_504() {
    let app = app_with(Slow, &[(GENERATION_TIMEOUT_SECS, "1")]).await;
    // Paused only after setup: the pool's connect timeout would otherwise fire
    // instantly against real file I/O.
    tokio::time::pause();
    let (status, response) = generate(app, body(drums_and_empty_bass(8), None)).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(response["error"]["code"], "generation_timeout");
}

#[tokio::test]
async fn limits_reflect_configuration() {
    let req = Request::get("/api/v1/songs/limits")
        .body(Body::empty())
        .unwrap();
    let (status, response) = call(
        app_with(MockProvider, &[(MAX_INPUT_TOKENS, "128")]).await,
        req,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        response,
        json!({
            "max_input_tokens": 128, "max_range_measures": 32,
            "max_song_measures": 128, "max_tracks": 16, "max_chat_messages": 20,
        })
    );
}

#[tokio::test]
async fn other_tracks_and_the_key_reach_the_provider() {
    let provider = Recording::default();
    let seen = provider.seen.clone();
    let mut request = body(drums_and_empty_bass(8), Some((1, 4)));
    request["song"]["key"] = json!({"tonic": "E", "mode": "minor"});
    let (status, _) = generate(app_with(provider, &[]).await, request).await;
    assert_eq!(status, StatusCode::OK);
    let seen = seen.lock().unwrap();
    let context = seen[0].context.as_deref().expect("context is sent");
    assert!(context.contains("key E minor"), "{context}");
    assert!(context.contains("Track \"Drums\" (drums):"), "{context}");
    assert!(context.contains("m1 kick: x"), "{context}");
    assert_eq!(seen[0].prompt, "driving eighth-note bass");
    assert_eq!(seen[0].tempo_bpm, Some(96));
}

#[tokio::test]
async fn a_zero_context_budget_sends_no_context() {
    let provider = Recording::default();
    let seen = provider.seen.clone();
    let (status, _) = generate(
        app_with(provider, &[(MAX_CONTEXT_TOKENS, "0")]).await,
        body(drums_and_empty_bass(8), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen.lock().unwrap()[0].context, None);
}
