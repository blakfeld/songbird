mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use api::config::{Config, AI_PROVIDER, GENERATION_TIMEOUT_SECS};
use api::provider::Providers;
use api::state::AppState;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use music::ai::plan::{PlanAction, PlanDraft, PlanProvider, PlanRequest};
use music::ai::{MockPlanProvider, MockProvider, PatternProvider, ProviderError};
use music::{GenerateRequest, Instrument, InstrumentRegistry, PatternDraft};
use serde_json::{json, Value};
use tower::ServiceExt;

const CHAT_URI: &str = "/api/v1/songs/chat";

#[derive(Clone, Default)]
struct RecordingPatterns {
    seen: Arc<Mutex<Vec<GenerateRequest>>>,
}

#[async_trait]
impl PatternProvider for RecordingPatterns {
    async fn generate(
        &self,
        request: &GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        self.seen.lock().unwrap().push(request.clone());
        MockProvider.generate(request, instrument).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct SlowPatterns;

#[async_trait]
impl PatternProvider for SlowPatterns {
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

#[derive(Clone, Default)]
struct RecordingPlans {
    seen: Arc<Mutex<Vec<PlanRequest>>>,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl PlanProvider for RecordingPlans {
    async fn plan(&self, request: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(request.clone());
        MockPlanProvider.plan(request).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct SlowPlans;

#[async_trait]
impl PlanProvider for SlowPlans {
    async fn plan(&self, _: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        unreachable!("the timeout fires first")
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct UnknownInstrument;

#[async_trait]
impl PlanProvider for UnknownInstrument {
    async fn plan(&self, _: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        Ok(PlanDraft {
            action: PlanAction::AddTrack,
            reply: "ok".into(),
            instrument: "kazoo".into(),
            track_name: "Kazoo".into(),
            prompt: "hum".into(),
            measures: None,
        })
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

async fn app_with(providers: Providers, extra: &[(&str, &str)]) -> axum::Router {
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
    let router = api::app(AppState::new(
        providers,
        InstrumentRegistry::builtin(),
        Arc::new(config),
        db.clone(),
    ));
    let router = common::session::signed_in(&db, router).await;
    db.keep_alive_with(router)
}

async fn chat(app: axum::Router, body: Value) -> (StatusCode, Value) {
    let req = Request::post(CHAT_URI)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
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

fn piano_track(id: &str) -> Value {
    track(
        id,
        "Piano",
        "piano",
        json!([{"id": format!("l{id}"), "name": "Chords", "measures": 1, "notes": [
            {"row_id": "C4", "step": 0, "length_steps": 4, "velocity": 100},
            {"row_id": "E4", "step": 0, "length_steps": 4, "velocity": 100}]}]),
        json!([{"id": format!("c{id}"), "loop_id": format!("l{id}"), "start_measure": 1, "measures": 4}]),
    )
}

fn user(text: &str) -> Value {
    json!({"role": "user", "content": text})
}

fn assistant(text: &str) -> Value {
    json!({"role": "assistant", "content": text})
}

fn row_ids(instrument: &str) -> Vec<String> {
    InstrumentRegistry::builtin()
        .get(instrument)
        .unwrap()
        .row_list()
        .into_iter()
        .map(|r| r.id)
        .collect()
}

#[tokio::test]
async fn a_request_for_a_part_adds_a_track() {
    let patterns = RecordingPatterns::default();
    let seen = patterns.seen.clone();
    let (status, response) = chat(
        app_with(Providers::with_patterns(patterns), &[]).await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("give me the drums to match")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let track = &response["track"];
    assert_eq!(track["instrument"], "drums");
    assert_eq!(track["name"], "Drums");
    assert_eq!(
        track["range"],
        json!({"start_measure": 1, "end_measure": 4})
    );
    let rows = row_ids("drums");
    let notes = track["notes"].as_array().unwrap();
    assert!(!notes.is_empty());
    for n in notes {
        assert!(rows.contains(&n["row_id"].as_str().unwrap().to_string()));
        assert!(n["step"].as_u64().unwrap() + n["length_steps"].as_u64().unwrap() <= 64);
    }
    assert!(!response["reply"].as_str().unwrap().is_empty());

    let seen = seen.lock().unwrap();
    let context = seen[0].context.as_deref().unwrap();
    assert!(context.contains("Track \"Piano\" (piano):"), "{context}");
    assert_eq!(seen[0].instrument.id, "drums");
}

#[tokio::test]
async fn an_empty_song_is_not_rejected_for_its_track_count() {
    let (status, response) = chat(
        app_with(Providers::mock(), &[]).await,
        json!({"song": song(4, vec![]), "messages": [user("give me the drums")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
}

#[tokio::test]
async fn a_question_gets_a_reply_and_no_generation() {
    let patterns = RecordingPatterns::default();
    let seen = patterns.seen.clone();
    let (status, response) = chat(
        app_with(Providers::with_patterns(patterns), &[]).await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("what tempo is this song?")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!response["reply"].as_str().unwrap().is_empty());
    assert_eq!(response["track"], Value::Null);
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_conversation_reaches_the_planner_and_the_rewritten_prompt_reaches_generation() {
    let patterns = RecordingPatterns::default();
    let generated = patterns.seen.clone();
    let plans = RecordingPlans::default();
    let planned = plans.seen.clone();
    let (status, _) = chat(
        app_with(Providers::new(patterns, plans), &[]).await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [
            user("give me a piano that plays slow jazzy chords"),
            assistant("Added a Piano track."),
            user("now the bass"),
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let planned = planned.lock().unwrap();
    for text in [
        "give me a piano that plays slow jazzy chords",
        "Added a Piano track.",
        "now the bass",
    ] {
        assert!(planned[0].user.contains(text), "{text}");
    }
    let generated = generated.lock().unwrap();
    assert_ne!(generated[0].prompt, "now the bass");
    assert!(generated[0].prompt.contains("bass"));
    assert_eq!(generated[0].instrument.id, "bass");
}

#[tokio::test]
async fn an_unknown_instrument_twice_is_502() {
    let (status, response) = chat(
        app_with(Providers::new(MockProvider, UnknownInstrument), &[]).await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("a kazoo")]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(response["error"]["code"], "generation_failed");
}

#[tokio::test]
async fn the_server_enforces_the_track_limit() {
    let tracks: Vec<Value> = (0..16).map(|i| piano_track(&format!("t{i}"))).collect();
    // Loop and clip ids must be unique across the song, so each track is distinct.
    let patterns = RecordingPatterns::default();
    let seen = patterns.seen.clone();
    let (status, response) = chat(
        app_with(Providers::with_patterns(patterns), &[]).await,
        json!({"song": song(4, tracks), "messages": [user("give me a bass")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["track"], Value::Null);
    assert!(response["reply"].as_str().unwrap().contains("16 tracks"));
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn too_many_messages_are_rejected_before_any_provider_call() {
    let plans = RecordingPlans::default();
    let calls = plans.calls.clone();
    let messages: Vec<Value> = (0..21).map(|_| user("hi")).collect();
    let (status, response) = chat(
        app_with(Providers::new(MockProvider, plans), &[]).await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": messages}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(response["error"]["code"], "invalid_request");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn every_invalid_body_is_400_with_its_own_code() {
    let app = || app_with(Providers::mock(), &[]);
    let (status, response) = chat(
        app().await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("hi"), assistant("hello")]}),
    )
    .await;
    assert_eq!(
        (status, &response["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("invalid_request"))
    );
    let (status, response) = chat(
        app().await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("  ")]}),
    )
    .await;
    assert_eq!(
        (status, &response["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("invalid_prompt"))
    );
    let mut bad_song = song(4, vec![piano_track("t1")]);
    bad_song["tempo_bpm"] = json!(1000);
    let (status, response) = chat(
        app().await,
        json!({"song": bad_song, "messages": [user("hi")]}),
    )
    .await;
    assert_eq!(
        (status, &response["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("invalid_song"))
    );
    let mut bad_instrument = song(4, vec![piano_track("t1")]);
    bad_instrument["tracks"][0]["instrument"] = json!("kazoo");
    let (status, response) = chat(
        app().await,
        json!({"song": bad_instrument, "messages": [user("hi")]}),
    )
    .await;
    assert_eq!(
        (status, &response["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("invalid_instrument"))
    );
    let (status, response) = chat(
        app().await,
        json!({"song": song(48, vec![piano_track("t1")]), "messages": [user("a bass")],
               "range": {"start_measure": 40, "end_measure": 60}}),
    )
    .await;
    assert_eq!(
        (status, &response["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("invalid_range"))
    );
    let (status, response) = chat(
        app().await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user(&"a".repeat(1025))]}),
    )
    .await;
    assert_eq!(
        (status, &response["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("prompt_too_long"))
    );
}

#[tokio::test]
async fn a_long_song_needs_a_loop_range() {
    let patterns = RecordingPatterns::default();
    let seen = patterns.seen.clone();
    let long = || song(48, vec![piano_track("t1")]);
    let (status, response) = chat(
        app_with(Providers::with_patterns(patterns.clone()), &[]).await,
        json!({"song": long(), "messages": [user("give me a bass part")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["track"], Value::Null);
    assert!(response["reply"].as_str().unwrap().contains("loop region"));
    assert!(seen.lock().unwrap().is_empty());

    let (status, response) = chat(
        app_with(Providers::with_patterns(patterns), &[]).await,
        json!({"song": long(), "messages": [user("give me a bass part")],
               "range": {"start_measure": 9, "end_measure": 16}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        response["track"]["range"],
        json!({"start_measure": 9, "end_measure": 16})
    );
    for n in response["track"]["notes"].as_array().unwrap() {
        assert!(n["step"].as_u64().unwrap() + n["length_steps"].as_u64().unwrap() <= 128);
    }
}

#[tokio::test]
async fn a_hanging_planner_is_504() {
    let app = app_with(
        Providers::new(MockProvider, SlowPlans),
        &[(GENERATION_TIMEOUT_SECS, "1")],
    )
    .await;
    // Real time: every request now touches the database for its session, and
    // paused time would fire the pool's acquire timeout while that I/O is pending.
    let (status, response) = chat(
        app,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("a bass")]}),
    )
    .await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(response["error"]["code"], "generation_timeout");
}

#[tokio::test]
async fn hanging_generation_is_504_after_a_successful_plan() {
    let app = app_with(
        Providers::with_patterns(SlowPatterns),
        &[(GENERATION_TIMEOUT_SECS, "1")],
    )
    .await;
    // Real time, for the reason given on the other timeout tests.
    let (status, response) = chat(
        app,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("a bass")]}),
    )
    .await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(response["error"]["code"], "generation_timeout");
}

fn one_measure_song(tracks: Vec<Value>) -> Value {
    song(1, tracks)
}

fn drum_track_with_one_clip() -> Value {
    track(
        "t1",
        "Drums",
        "drums",
        json!([{"id": "l1", "name": "Beat", "measures": 1, "notes": [
            {"row_id": "kick", "step": 0, "length_steps": 1, "velocity": 100}]}]),
        json!([{"id": "c1", "loop_id": "l1", "start_measure": 1, "measures": 1}]),
    )
}

fn empty_track() -> Value {
    track("t0", "Track 1", "drums", json!([]), json!([]))
}

#[tokio::test]
async fn a_named_length_grows_a_one_measure_song() {
    let (status, response) = chat(
        app_with(Providers::mock(), &[]).await,
        json!({"song": one_measure_song(vec![drum_track_with_one_clip()]),
               "messages": [user("16 bars of slow jazzy piano")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["track"]["instrument"], "piano");
    assert_eq!(
        response["track"]["range"],
        json!({"start_measure": 1, "end_measure": 16})
    );
    let notes = response["track"]["notes"].as_array().unwrap();
    assert!(notes.iter().any(|n| n["step"].as_u64().unwrap() >= 16 * 15));
}

#[tokio::test]
async fn an_empty_song_defaults_to_eight_measures() {
    let (status, response) = chat(
        app_with(Providers::mock(), &[]).await,
        json!({"song": one_measure_song(vec![empty_track()]),
               "messages": [user("give me a drum beat")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["track"]["instrument"], "drums");
    assert_eq!(
        response["track"]["range"],
        json!({"start_measure": 1, "end_measure": 8})
    );
}

#[tokio::test]
async fn without_a_named_length_a_song_with_clips_uses_its_own_length() {
    let (status, response) = chat(
        app_with(Providers::mock(), &[]).await,
        json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("a bass please")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        response["track"]["range"],
        json!({"start_measure": 1, "end_measure": 4})
    );
}
