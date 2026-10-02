mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use api::config::{Config, AI_PROVIDER, GENERATION_TIMEOUT_SECS, MAX_CONCURRENT_GENERATIONS};
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
    let router = api::app(AppState {
        providers,
        instruments: InstrumentRegistry::builtin(),
        config: Arc::new(config),
        db: db.clone(),
    });
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
    // Paused only after setup: the pool's connect timeout would otherwise fire
    // instantly against real file I/O.
    tokio::time::pause();
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
    tokio::time::pause();
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

fn audio_song_parts() -> (Value, Value) {
    let sample = json!({
        "id": "s1", "name": "Vocal take", "sample_rate": 48000, "channels": 1,
        "length_samples": 96000, "origin": "import",
    });
    let mut vocals = track("t9", "Vocals", "audio", json!([]), json!([]));
    vocals["audio_clips"] = json!([{
        "id": "a1", "sample_id": "s1", "start_ticks": 0, "offset_samples": 0,
        "slice_samples": 96000, "length_samples": 96000,
    }]);
    (sample, vocals)
}

#[tokio::test]
async fn chat_ignores_audio_tracks() {
    let (sample, vocals) = audio_song_parts();
    let mut s = song(4, vec![piano_track("t1"), vocals]);
    s["samples"] = json!([sample]);
    let patterns = RecordingPatterns::default();
    let generated = patterns.seen.clone();
    let plans = RecordingPlans::default();
    let planned = plans.seen.clone();
    let (status, response) = chat(
        app_with(Providers::new(patterns, plans), &[]).await,
        json!({"song": s, "messages": [user("give me a bass part")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["track"]["instrument"], "bass");

    let generated = generated.lock().unwrap();
    let context = generated[0].context.as_deref().unwrap();
    assert!(context.contains("Track \"Piano\" (piano):"), "{context}");
    assert!(!context.contains("Vocals"), "{context}");
    assert!(!planned.lock().unwrap()[0].user.contains("Vocals"));
}

#[tokio::test]
async fn audio_tracks_count_toward_the_chat_track_limit() {
    let (sample, vocals) = audio_song_parts();
    let mut tracks: Vec<Value> = (0..15).map(|i| piano_track(&format!("t{i}"))).collect();
    tracks.push(vocals);
    let mut s = song(4, tracks);
    s["samples"] = json!([sample]);
    let (status, response) = chat(
        app_with(Providers::mock(), &[]).await,
        json!({"song": s, "messages": [user("give me a bass")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["track"], Value::Null);
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

async fn post_status(app: &axum::Router, uri: &str, body: Value) -> StatusCode {
    let req = Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

async fn single_slot_app() -> (axum::Router, Arc<tokio::sync::Notify>) {
    let started = Arc::new(tokio::sync::Notify::new());
    let app = app_with(
        Providers::with_patterns(BlockingPatterns(started.clone())),
        &[
            (MAX_CONCURRENT_GENERATIONS, "1"),
            (GENERATION_TIMEOUT_SECS, "3600"),
        ],
    )
    .await;
    (app, started)
}

fn chat_body() -> Value {
    json!({"song": song(4, vec![piano_track("t1")]), "messages": [user("give me the drums to match")]})
}

#[tokio::test]
async fn all_generation_routes_share_one_budget_and_cheap_routes_stay_available() {
    let (app, started) = single_slot_app().await;
    let first = tokio::spawn(chat(app.clone(), chat_body()));
    started.notified().await;

    // The limiter runs before body validation, so any body shows the shed.
    for uri in [
        CHAT_URI,
        "/api/v1/patterns/generate",
        "/api/v1/songs/tracks/generate",
    ] {
        assert_eq!(
            post_status(&app, uri, json!({})).await,
            StatusCode::SERVICE_UNAVAILABLE,
            "{uri}"
        );
    }
    let (_, response) = chat(app.clone(), chat_body()).await;
    assert_eq!(response["error"]["code"], "generation_busy");

    for uri in [
        "/healthz",
        "/api/v1/songs/limits",
        "/api/v1/patterns/limits",
    ] {
        let res = app
            .clone()
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
    }
    first.abort();
}

#[tokio::test]
async fn the_slot_is_released_when_a_generation_is_abandoned() {
    let (app, started) = single_slot_app().await;
    let first = tokio::spawn(chat(app.clone(), chat_body()));
    started.notified().await;
    first.abort();
    let _ = first.await;

    // Reaching the provider again (and so blocking) proves the slot was free; a shed returns at once.
    let next = tokio::time::timeout(
        Duration::from_millis(300),
        post_status(&app, CHAT_URI, chat_body()),
    )
    .await;
    assert!(
        next.is_err(),
        "expected the request to be running, got {next:?}"
    );
}

#[tokio::test]
async fn chat_sends_keys_samplers_as_context_but_not_pads() {
    let sample = json!({
        "id": "s1", "name": "Vox", "sample_rate": 48000, "channels": 1,
        "length_samples": 96000, "origin": "import",
    });
    let mut keys = track(
        "t8",
        "Vox",
        "sampler-keys",
        json!([{"id": "lk", "name": "Line", "measures": 1, "notes": [
            {"row_id": "A2", "step": 0, "length_steps": 4, "velocity": 100}]}]),
        json!([{"id": "ck", "loop_id": "lk", "start_measure": 1, "measures": 4}]),
    );
    keys["sampler"] = json!({"keys": {"sample_id": "s1", "root_note": 60, "one_shot": false}});
    let mut pads = track(
        "t9",
        "Kit",
        "sampler-pads",
        json!([{"id": "lp", "name": "Hits", "measures": 1, "notes": [
            {"row_id": "pad-1", "step": 0, "length_steps": 1, "velocity": 100}]}]),
        json!([{"id": "cp", "loop_id": "lp", "start_measure": 1, "measures": 4}]),
    );
    pads["sampler"] = json!({"pads": [{"row_id": "pad-1", "sample_id": "s1"}]});
    let mut s = song(4, vec![keys, pads]);
    s["samples"] = json!([sample]);
    let patterns = RecordingPatterns::default();
    let generated = patterns.seen.clone();
    let plans = RecordingPlans::default();
    let planned = plans.seen.clone();
    let (status, response) = chat(
        app_with(Providers::new(patterns, plans), &[]).await,
        json!({"song": s, "messages": [user("give me a bass part")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["track"]["instrument"], "bass");

    let generated = generated.lock().unwrap();
    let context = generated[0].context.as_deref().unwrap();
    assert!(context.contains("Track \"Vox (sampler)\""), "{context}");
    assert!(context.contains("A2"), "{context}");
    assert!(!context.contains("Kit"), "{context}");
    let planner_prompt = &planned.lock().unwrap()[0].user;
    assert!(!planner_prompt.contains("Vox") && !planner_prompt.contains("Kit"));
}
