mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use api::config::{Config, AI_PROVIDER, ENV, GENERATION_TIMEOUT_SECS, MAX_INPUT_TOKENS};
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

/// Records calls so "provider not invoked" can be asserted.
struct Counting<P> {
    inner: P,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl<P: PatternProvider> PatternProvider for Counting<P> {
    async fn generate(
        &self,
        request: &GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.generate(request, instrument).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Failing;

#[async_trait]
impl PatternProvider for Failing {
    async fn generate(
        &self,
        _: &GenerateRequest,
        _: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        Err(ProviderError::Request(
            "upstream said: secret detail".into(),
        ))
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

struct Unusable;

#[async_trait]
impl PatternProvider for Unusable {
    async fn generate(
        &self,
        _: &GenerateRequest,
        _: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        Ok(
            PatternDraft::from_json(json!({"name": "x", "sections": [], "arrangement": []}))
                .unwrap(),
        )
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
        if k == ENV {
            return Some("development".into());
        }
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
        Providers::with_patterns(provider),
        InstrumentRegistry::builtin(),
        Arc::new(config),
        db.clone(),
    ));
    let router = common::session::signed_in(&db, router).await;
    db.keep_alive_with(router)
}

fn counted_mock() -> (Counting<MockProvider>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    (
        Counting {
            inner: MockProvider,
            calls: calls.clone(),
        },
        calls,
    )
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
    let req = Request::post("/api/v1/patterns/generate")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    call(app, req).await
}

async fn get(app: axum::Router, uri: &str) -> (StatusCode, Value) {
    call(app, Request::get(uri).body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn generates_with_defaults() {
    let (provider, calls) = counted_mock();
    let (status, body) = generate(
        app_with(provider, &[]).await,
        json!({"instrument": "drums", "prompt": "four on the floor house beat", "measures": 4}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(body["instrument"], "drums");
    assert_eq!(body["measures"], 4);
    assert_eq!(body["time_signature"], "4/4");
    assert_eq!(body["version"], 1);
    let tempo = body["tempo_bpm"].as_u64().unwrap();
    assert!((40..=240).contains(&tempo));
}

#[tokio::test]
async fn rows_and_channel_equal_the_instruments_listing() {
    let app = app_with(MockProvider, &[]).await;
    let (_, instruments) = get(app.clone(), "/api/v1/instruments").await;
    let (_, pattern) = generate(
        app,
        json!({"instrument": "drums", "prompt": "rock", "measures": 8}),
    )
    .await;
    assert_eq!(pattern["rows"], instruments[0]["rows"]);
    assert_eq!(pattern["midi_channel"], instruments[0]["midi_channel"]);
}

#[tokio::test]
async fn explicit_tempo_is_honored() {
    let (status, body) = generate(
        app_with(MockProvider, &[]).await,
        json!({"instrument": "drums", "prompt": "trap hats", "measures": 8, "tempo_bpm": 140}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tempo_bpm"], 140);
}

#[tokio::test]
async fn every_allowed_length_produces_a_pattern_of_that_length() {
    for measures in [4, 8, 12, 16, 32] {
        let (status, body) = generate(
            app_with(MockProvider, &[]).await,
            json!({"instrument": "drums", "prompt": "boom bap", "measures": measures}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["measures"], measures);
        let total = measures * body["steps_per_measure"].as_i64().unwrap();
        for note in body["notes"].as_array().unwrap() {
            let end = note["step"].as_i64().unwrap() + note["length_steps"].as_i64().unwrap();
            assert!(end <= total);
        }
    }
}

#[tokio::test]
async fn validation_errors_are_422_and_never_call_the_provider() {
    let long = "a".repeat(1025);
    let cases = [
        (
            json!({"instrument": "kazoo", "prompt": "x", "measures": 4}),
            "invalid_instrument",
        ),
        (json!({"prompt": "x", "measures": 4}), "invalid_instrument"),
        (
            json!({"instrument": "drums", "prompt": "x", "measures": 10}),
            "invalid_measures",
        ),
        (
            json!({"instrument": "drums", "prompt": "x", "measures": 64}),
            "invalid_measures",
        ),
        (
            json!({"instrument": "drums", "prompt": "   ", "measures": 4}),
            "invalid_prompt",
        ),
        (
            json!({"instrument": "drums", "prompt": "x", "measures": 4, "tempo_bpm": 300}),
            "invalid_tempo",
        ),
        (
            json!({"instrument": "drums", "prompt": "x", "measures": 4, "time_signature": "5/4"}),
            "invalid_time_signature",
        ),
        (
            json!({"instrument": "drums", "prompt": "x", "measures": 4, "swing": 0.9}),
            "invalid_swing",
        ),
        (
            json!({"instrument": "drums", "prompt": long, "measures": 4}),
            "prompt_too_long",
        ),
    ];
    for (body, code) in cases {
        let (provider, calls) = counted_mock();
        let (status, response) = generate(app_with(provider, &[]).await, body.clone()).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(response["error"]["code"], code, "{body}");
        assert!(response["error"]["message"]
            .as_str()
            .is_some_and(|m| !m.is_empty()));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{body}");
    }
}

#[tokio::test]
async fn prompt_limit_comes_from_configuration() {
    let (provider, calls) = counted_mock();
    let app = app_with(provider, &[(MAX_INPUT_TOKENS, "128")]).await;
    let (status, _) = generate(
        app.clone(),
        json!({"instrument": "drums", "prompt": "a".repeat(512), "measures": 4}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = generate(
        app,
        json!({"instrument": "drums", "prompt": "a".repeat(513), "measures": 4}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "prompt_too_long");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_body_is_invalid_json() {
    let req = Request::post("/api/v1/patterns/generate")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{oops"))
        .unwrap();
    let (status, body) = call(app_with(MockProvider, &[]).await, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_json");
}

#[tokio::test]
async fn provider_failure_is_502_without_leaking_details() {
    let (status, body) = generate(
        app_with(Failing, &[]).await,
        json!({"instrument": "drums", "prompt": "x", "measures": 4}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"]["code"], "generation_failed");
    assert!(!body.to_string().contains("secret detail"));
}

#[tokio::test]
async fn unusable_drafts_twice_are_502_after_exactly_one_retry() {
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = Counting {
        inner: Unusable,
        calls: calls.clone(),
    };
    let (status, body) = generate(
        app_with(provider, &[]).await,
        json!({"instrument": "drums", "prompt": "x", "measures": 4}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"]["code"], "generation_failed");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn slow_provider_times_out_with_504() {
    let app = app_with(Slow, &[(GENERATION_TIMEOUT_SECS, "1")]).await;
    // Real time: every request now touches the database for its session, and
    // paused time would fire the pool's acquire timeout while that I/O is pending.
    let (status, body) = generate(
        app,
        json!({"instrument": "drums", "prompt": "x", "measures": 4}),
    )
    .await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(body["error"]["code"], "generation_timeout");
}

#[tokio::test]
async fn limits_reflect_configuration() {
    let (status, body) = get(
        app_with(MockProvider, &[(MAX_INPUT_TOKENS, "128")]).await,
        "/api/v1/patterns/limits",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"max_input_tokens": 128, "measure_options": [4, 8, 12, 16, 32]})
    );
}

#[tokio::test]
async fn instruments_lists_the_full_catalog_in_order() {
    let (status, body) = get(app_with(MockProvider, &[]).await, "/api/v1/instruments").await;
    assert_eq!(status, StatusCode::OK);
    let list = body.as_array().unwrap();
    let listed: Vec<&str> = list.iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(
        listed,
        [
            "drums",
            "piano",
            "electric-piano",
            "organ",
            "bass",
            "synth-lead",
            "synth-pad",
            "strings",
            "pluck",
            "vocal"
        ]
    );
    assert_eq!(list[0]["kind"], "drums");
    assert_eq!(list[0]["midi_channel"], 10);
    assert_eq!(list[0]["midi_program"], Value::Null);
    assert_eq!(list[0]["range"], Value::Null);
    assert_eq!(list[0]["sustained"], false);
    let ids: Vec<&str> = list[0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "kick",
            "snare",
            "rim",
            "clap",
            "hat_closed",
            "hat_pedal",
            "hat_open",
            "tom_low",
            "tom_mid",
            "tom_high",
            "crash",
            "ride"
        ]
    );
    assert_eq!(list[0]["rows"][0]["midi_note"], 36);

    let piano = &list[1];
    assert_eq!(piano["name"], "Piano");
    assert_eq!(piano["kind"], "melodic");
    assert_eq!(piano["midi_channel"], 1);
    assert_eq!(piano["midi_program"], 1);
    assert_eq!(piano["range"], json!({"low": 36, "high": 96}));
    assert_eq!(piano["sustained"], true);
    let rows = piano["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 61);
    assert_eq!(rows[0], json!({"id": "C7", "name": "C7", "midi_note": 96}));
    assert_eq!(rows[60], json!({"id": "C2", "name": "C2", "midi_note": 36}));
    assert!(rows.contains(&json!({"id": "C#4", "name": "C#4", "midi_note": 61})));
}

#[tokio::test]
async fn generates_a_piano_pattern_with_all_rows_and_program_one() {
    let app = app_with(MockProvider, &[]).await;
    let (_, instruments) = get(app.clone(), "/api/v1/instruments").await;
    let (status, pattern) = generate(
        app,
        json!({"instrument": "piano", "prompt": "gentle ballad", "measures": 8}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pattern["instrument"], "piano");
    assert_eq!(pattern["midi_program"], 1);
    assert_eq!(pattern["midi_channel"], 1);
    assert_eq!(pattern["rows"], instruments[1]["rows"]);
    assert_eq!(pattern["rows"].as_array().unwrap().len(), 61);
    let notes = pattern["notes"].as_array().unwrap();
    assert!(!notes.is_empty());
    let row_ids: Vec<&Value> = pattern["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| &r["id"])
        .collect();
    assert!(notes.iter().all(|n| row_ids.contains(&&n["row_id"])));
}

#[tokio::test]
async fn piano_pattern_exports_to_a_parseable_midi_with_its_program() {
    let app = app_with(MockProvider, &[]).await;
    let (_, mut pattern) = generate(
        app.clone(),
        json!({"instrument": "piano", "prompt": "gentle ballad", "measures": 4}),
    )
    .await;
    let (status, headers, bytes) = export(app.clone(), &pattern).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "audio/midi");
    let smf = midly::Smf::parse(&bytes).unwrap();
    let programs: Vec<u8> = smf
        .tracks
        .iter()
        .flatten()
        .filter_map(|e| match e.kind {
            midly::TrackEventKind::Midi {
                channel,
                message: midly::MidiMessage::ProgramChange { program },
            } => {
                assert_eq!(channel.as_int(), 0);
                Some(program.as_int())
            }
            _ => None,
        })
        .collect();
    assert_eq!(programs, [0]);

    // Patterns saved without a program still export with the instrument's.
    pattern.as_object_mut().unwrap().remove("midi_program");
    let (status, _, bytes) = export(app, &pattern).await;
    assert_eq!(status, StatusCode::OK);
    let smf = midly::Smf::parse(&bytes).unwrap();
    assert!(smf.tracks.iter().flatten().any(|e| matches!(
        e.kind,
        midly::TrackEventKind::Midi {
            message: midly::MidiMessage::ProgramChange { .. },
            ..
        }
    )));
}

#[tokio::test]
async fn drums_pattern_without_midi_program_exports_without_program_change() {
    let app = app_with(MockProvider, &[]).await;
    let (_, mut pattern) = generate(
        app.clone(),
        json!({"instrument": "drums", "prompt": "rock", "measures": 4}),
    )
    .await;
    pattern.as_object_mut().unwrap().remove("midi_program");
    let (status, _, bytes) = export(app, &pattern).await;
    assert_eq!(status, StatusCode::OK);
    let smf = midly::Smf::parse(&bytes).unwrap();
    assert!(!smf.tracks.iter().flatten().any(|e| matches!(
        e.kind,
        midly::TrackEventKind::Midi {
            message: midly::MidiMessage::ProgramChange { .. },
            ..
        }
    )));
}

async fn export(
    app: axum::Router,
    pattern: &Value,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let req = Request::post("/api/v1/patterns/export/midi")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(pattern.to_string()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes().to_vec(),
    )
}

#[tokio::test]
async fn export_returns_a_midi_file_matching_the_pattern() {
    let app = app_with(MockProvider, &[]).await;
    let (_, mut pattern) = generate(
        app.clone(),
        json!({"instrument": "drums", "prompt": "boom bap", "measures": 4, "tempo_bpm": 90}),
    )
    .await;
    pattern["name"] = json!("Boom Bap");
    pattern["swing"] = json!(0.0);
    pattern["notes"] = json!([
        {"row_id": "kick", "step": 0, "length_steps": 8, "velocity": 110},
        {"row_id": "snare", "step": 4, "length_steps": 1, "velocity": 90}
    ]);

    let (status, headers, bytes) = export(app, &pattern).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "audio/midi");
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"songbird-boom-bap-90bpm.mid\""
    );

    let smf = midly::Smf::parse(&bytes).unwrap();
    assert_eq!(smf.header.timing, midly::Timing::Metrical(480.into()));
    let mut notes = Vec::new();
    for track in &smf.tracks {
        let mut tick = 0u32;
        for event in track {
            tick += event.delta.as_int();
            if let midly::TrackEventKind::Midi { channel, message } = event.kind {
                assert_eq!(channel.as_int(), 9);
                match message {
                    midly::MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                        notes.push((key.as_int(), tick, Some(vel.as_int()), "on"))
                    }
                    midly::MidiMessage::NoteOff { key, .. }
                    | midly::MidiMessage::NoteOn { key, .. } => {
                        notes.push((key.as_int(), tick, None, "off"))
                    }
                    _ => {}
                }
            }
        }
    }
    assert!(notes.contains(&(36, 0, Some(110), "on")));
    assert!(notes.contains(&(36, 960, None, "off")));
    assert!(notes.contains(&(38, 480, Some(90), "on")));
    assert!(notes.contains(&(38, 600, None, "off")));
    assert_eq!(notes.len(), 4);
}

#[tokio::test]
async fn export_rejects_an_unknown_row_with_422() {
    let app = app_with(MockProvider, &[]).await;
    let (_, mut pattern) = generate(
        app.clone(),
        json!({"instrument": "drums", "prompt": "rock", "measures": 4}),
    )
    .await;
    pattern["notes"] = json!([{"row_id": "cowbell", "step": 0, "length_steps": 1, "velocity": 90}]);
    let (status, _, bytes) = export(app, &pattern).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["code"], "invalid_pattern");
}

#[tokio::test]
async fn export_rejects_out_of_range_numbers_without_panicking() {
    let app = app_with(MockProvider, &[]).await;
    let (_, pattern) = generate(
        app.clone(),
        json!({"instrument": "drums", "prompt": "rock", "measures": 4}),
    )
    .await;
    let edits: [(&str, Value); 7] = [
        ("tempo_bpm", json!(0)),
        ("tempo_bpm", json!(1)),
        ("swing", json!(1e12)),
        ("steps_per_measure", json!(4_000_000_000u64)),
        ("midi_channel", json!(0)),
        (
            "notes",
            json!([{"row_id": "kick", "step": 4294967295u64, "length_steps": 1, "velocity": 90}]),
        ),
        (
            "notes",
            json!([{"row_id": "kick", "step": 0, "length_steps": 0, "velocity": 90}]),
        ),
    ];
    for (field, value) in edits {
        let mut bad = pattern.clone();
        bad[field] = value.clone();
        let (status, _, bytes) = export(app.clone(), &bad).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{field}={value}");
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "invalid_pattern", "{field}={value}");
    }
}

#[tokio::test]
async fn export_rejects_a_non_pattern_body_as_invalid_json() {
    let (status, _, bytes) =
        export(app_with(MockProvider, &[]).await, &json!({"measures": 10})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["code"], "invalid_json");
}

#[tokio::test]
async fn every_new_instrument_generates_a_pattern_matching_its_listing() {
    let app = app_with(MockProvider, &[]).await;
    let (_, instruments) = get(app.clone(), "/api/v1/instruments").await;
    let instruments = instruments.as_array().unwrap();

    for id in [
        "electric-piano",
        "organ",
        "bass",
        "synth-lead",
        "synth-pad",
        "strings",
        "pluck",
        "vocal",
    ] {
        let listing = instruments.iter().find(|i| i["id"] == id).unwrap();
        let (status, pattern) = generate(
            app.clone(),
            json!({"instrument": id, "prompt": "something nice", "measures": 8}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{id}");
        assert_eq!(pattern["instrument"], id);
        assert_eq!(pattern["rows"], listing["rows"], "{id}");
        assert_eq!(pattern["midi_channel"], listing["midi_channel"], "{id}");
        assert_eq!(pattern["midi_program"], listing["midi_program"], "{id}");

        let notes = pattern["notes"].as_array().unwrap();
        assert!(!notes.is_empty(), "{id}");
        if id == "bass" || id == "synth-lead" {
            let mut steps: Vec<u64> = notes.iter().map(|n| n["step"].as_u64().unwrap()).collect();
            let total = steps.len();
            steps.sort_unstable();
            steps.dedup();
            assert_eq!(steps.len(), total, "{id} has stacked notes");
        }
    }
}
