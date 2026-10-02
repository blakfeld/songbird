//! The streamed form of `POST /api/v1/songs/chat`: event protocol, keepalives, cancellation and
//! the busy limit. The JSON form is covered by `chat.rs`.

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use api::ai_access::{AiAccess, MockUserProviders};
use api::config::{GENERATION_TIMEOUT_SECS, MASTER_KEYS, MAX_CONCURRENT_GENERATIONS};
use api::provider::Providers;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{header, StatusCode};
use common::app::{request, song, TestApp};
use http_body_util::BodyExt;
use music::ai::plan::{PlanAction, PlanDraft, PlanProvider, PlanRequest};
use music::ai::StreamingMockPlanProvider;
use music::ai::{MockPlanProvider, MockProvider, PatternProvider, ProviderError, TextSink};
use music::{GenerateRequest, Instrument, PatternDraft};
use serde_json::{json, Value};
use tokio::sync::{Notify, Semaphore};
use tower::ServiceExt;

const CHAT_URI: &str = "/api/v1/songs/chat";

fn chat_body(message: &str) -> Value {
    json!({"song": song("Late Train", 1), "messages": [{"role": "user", "content": message}]})
}

fn streaming_request(cookie: &str, body: Value) -> axum::http::Request<Body> {
    let mut req = request("POST", CHAT_URI, Some(cookie), Some(body));
    req.headers_mut()
        .insert(header::ACCEPT, "text/event-stream".parse().unwrap());
    req
}

async fn open(app: &TestApp, cookie: &str, message: &str) -> axum::response::Response {
    app.router
        .clone()
        .oneshot(streaming_request(cookie, chat_body(message)))
        .await
        .unwrap()
}

async fn read_text(response: axum::response::Response) -> String {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// Comment lines are dropped, as a client drops them, so what remains is the events.
fn parse_events(text: &str) -> Vec<(String, Value)> {
    text.split("\n\n")
        .filter(|block| !block.trim().is_empty() && !block.starts_with(':'))
        .map(|block| {
            let mut name = String::new();
            let mut data = String::new();
            for line in block.lines() {
                if let Some(rest) = line.strip_prefix("event: ") {
                    name = rest.to_string();
                } else if let Some(rest) = line.strip_prefix("data: ") {
                    data.push_str(rest);
                }
            }
            (name, serde_json::from_str(&data).expect("data is JSON"))
        })
        .collect()
}

fn names(events: &[(String, Value)]) -> Vec<&str> {
    events.iter().map(|(n, _)| n.as_str()).collect()
}

async fn stream_for(
    providers: Providers,
    extra: &[(&str, &str)],
    message: &str,
) -> (Vec<(String, Value)>, axum::http::HeaderMap) {
    let app = app_with(providers, extra).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = open(&app, &cookie, message).await;
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    (parse_events(&read_text(response).await), headers)
}

async fn app_with(providers: Providers, extra: &[(&str, &str)]) -> TestApp {
    TestApp::with_state(extra, |state| state.ai = AiAccess::Shared(providers)).await
}

fn fast_streaming_planner() -> StreamingMockPlanProvider {
    StreamingMockPlanProvider::with_delay(Duration::ZERO)
}

#[derive(Clone, Default)]
struct CountingPatterns(Arc<AtomicUsize>);

#[async_trait]
impl PatternProvider for CountingPatterns {
    async fn generate(
        &self,
        request: &GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        MockProvider.generate(request, instrument).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct FailingPatterns(ProviderError);

#[async_trait]
impl PatternProvider for FailingPatterns {
    async fn generate(
        &self,
        _: &GenerateRequest,
        _: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        Err(self.0.clone())
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

/// Fails its first attempt after streaming part of a reply, so the retry path is visible.
#[derive(Default)]
struct RetryingPlans(AtomicUsize);

fn draft(instrument: &str, reply: &str) -> PlanDraft {
    PlanDraft {
        action: PlanAction::AddTrack,
        reply: reply.into(),
        instrument: instrument.into(),
        track_name: "Part".into(),
        prompt: "a part".into(),
        measures: None,
    }
}

#[async_trait]
impl PlanProvider for RetryingPlans {
    async fn plan(&self, _: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        unreachable!("the planner streams")
    }

    async fn plan_streaming(
        &self,
        _: &PlanRequest,
        text: &TextSink<'_>,
    ) -> Result<PlanDraft, ProviderError> {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            text.emit(r#"{"action":"add_track","reply":"First "#);
            return Ok(draft("kazoo", "First "));
        }
        text.emit(r#"{"action":"add_track","reply":"Second try"}"#);
        Ok(draft("bass", "Second try"))
    }

    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

/// Waits on a gate so a test can hold a request in the planning stage.
struct GatedPlans {
    started: Arc<Notify>,
    gate: Arc<Semaphore>,
    dropped: Arc<AtomicBool>,
}

struct SetOnDrop(Arc<AtomicBool>);

impl Drop for SetOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl PlanProvider for GatedPlans {
    async fn plan(&self, request: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        let _flag = SetOnDrop(self.dropped.clone());
        self.started.notify_one();
        let _permit = self.gate.acquire().await.unwrap();
        MockPlanProvider.plan(request).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct StalledPlans(Duration);

#[async_trait]
impl PlanProvider for StalledPlans {
    async fn plan(&self, request: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        tokio::time::sleep(self.0).await;
        MockPlanProvider.plan(request).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[tokio::test]
async fn a_streamed_request_for_a_part_sends_progress_deltas_and_one_result() {
    let providers = Providers::new(MockProvider, fast_streaming_planner());
    let (events, headers) = stream_for(providers, &[], "give me the drums to match").await;

    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store, no-transform");
    assert_eq!(headers["x-accel-buffering"], "no");

    let names = names(&events);
    assert_eq!(names[0], "progress");
    assert_eq!(events[0].1, json!({"stage": "planning"}));
    let writing = events
        .iter()
        .position(|(n, d)| n == "progress" && d["stage"] == "writing")
        .expect("a writing event");
    assert_eq!(
        events[writing].1,
        json!({"stage": "writing", "name": "Drums", "instrument": "drums"})
    );
    assert!(names[1..writing].iter().all(|n| *n == "reply_delta"));
    assert!(writing > 1, "the reply streamed before the writing step");
    assert_eq!(names.len(), writing + 2);
    assert_eq!(names[writing + 1], "result");

    let streamed: String = events[1..writing]
        .iter()
        .map(|(_, d)| d["text"].as_str().unwrap())
        .collect();
    let result = &events[writing + 1].1;
    assert!(result["reply"].as_str().unwrap().starts_with(&streamed));
    assert_eq!(result["track"]["instrument"], "drums");
    assert!(!result["track"]["notes"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_streamed_question_gets_a_reply_only_result() {
    let providers = Providers::new(MockProvider, fast_streaming_planner());
    let (events, _) = stream_for(providers, &[], "what tempo is this song?").await;
    assert!(!events
        .iter()
        .any(|(n, d)| n == "progress" && d["stage"] == "writing"));
    let (last, data) = events.last().unwrap();
    assert_eq!(last, "result");
    assert!(data["track"].is_null());
    assert!(!data["reply"].as_str().unwrap().is_empty());
    assert_eq!(events.iter().filter(|(n, _)| n == "result").count(), 1);
}

#[tokio::test]
async fn a_provider_that_cannot_stream_sends_no_deltas_and_the_full_reply_in_the_result() {
    let providers = Providers::new(MockProvider, MockPlanProvider);
    let (events, _) = stream_for(providers, &[], "give me the drums to match").await;
    let names = names(&events);
    assert_eq!(names, ["progress", "progress", "result"]);
    assert_eq!(events[2].1["reply"], "Added a Drums track.");
}

#[tokio::test]
async fn a_timeout_after_the_plan_ends_the_stream_with_one_error_event() {
    let providers = Providers::new(SlowPatterns, fast_streaming_planner());
    let (events, _) = stream_for(
        providers,
        &[(GENERATION_TIMEOUT_SECS, "1")],
        "give me the drums to match",
    )
    .await;
    let (last, data) = events.last().unwrap();
    assert_eq!(last, "error");
    assert_eq!(data["code"], "generation_timeout");
    assert!(data.get("retry_after").is_none());
    assert!(!events.iter().any(|(n, _)| n == "result"));
    assert_eq!(events.iter().filter(|(n, _)| n == "error").count(), 1);
}

#[tokio::test]
async fn a_rate_limit_in_the_stream_carries_retry_after() {
    let providers = Providers::new(
        FailingPatterns(ProviderError::RateLimited {
            retry_after: Some(30),
        }),
        fast_streaming_planner(),
    );
    let (events, _) = stream_for(providers, &[], "give me the drums to match").await;
    let (last, data) = events.last().unwrap();
    assert_eq!(last, "error");
    assert_eq!(data["code"], "api_key_rate_limited");
    assert_eq!(data["retry_after"], 30);
    assert!(data["message"].as_str().unwrap().contains("rate limited"));
}

#[tokio::test]
async fn a_validation_error_is_a_plain_400_and_no_provider_is_called() {
    let patterns = CountingPatterns::default();
    let app = app_with(
        Providers::new(patterns.clone(), fast_streaming_planner()),
        &[],
    )
    .await;
    let cookie = app.cookie_for("ana@example.com").await;
    let messages: Vec<Value> = (0..21)
        .map(|i| json!({"role": "user", "content": format!("m{i}")}))
        .collect();
    let body = json!({"song": song("Late Train", 1), "messages": messages});
    let response = app
        .router
        .clone()
        .oneshot(streaming_request(&cookie, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let body: Value = serde_json::from_str(&read_text(response).await).unwrap();
    assert_eq!(body["error"]["code"], "invalid_request");
    assert_eq!(app.calls(), 0);
    assert_eq!(patterns.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_missing_ai_key_is_a_plain_http_error_not_a_stream() {
    const KEYRING: &str = "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let app = TestApp::with_state(&[(MASTER_KEYS, KEYRING)], |state| {
        state.ai = AiAccess::PerUser(Arc::new(MockUserProviders));
    })
    .await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = open(&app, &cookie, "give me the drums").await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let body: Value = serde_json::from_str(&read_text(response).await).unwrap();
    assert_eq!(body["error"]["code"], "api_key_required");
}

#[tokio::test]
async fn a_planner_retry_sends_reply_reset_before_the_second_attempts_text() {
    let providers = Providers::new(MockProvider, RetryingPlans::default());
    let (events, _) = stream_for(providers, &[], "give me a bass").await;
    // Text the client had not been sent when the reset arrived is dropped by the queue, so the
    // first attempt's delta is present only if the reader got to it in time.
    let reset = events
        .iter()
        .position(|(n, _)| n == "reply_reset")
        .expect("a reset");
    assert_eq!(events[reset].1, json!({}));
    for (name, data) in &events[1..reset] {
        assert_eq!(
            (name.as_str(), data),
            ("reply_delta", &json!({"text": "First "}))
        );
    }
    let after: Vec<&str> = names(&events)[reset + 1..].to_vec();
    assert_eq!(after, ["reply_delta", "progress", "result"]);
    assert_eq!(events[reset + 1].1, json!({"text": "Second try"}));
    assert_eq!(events.last().unwrap().1["reply"], "Second try");
}

#[tokio::test]
async fn without_the_accept_header_the_response_is_the_same_json_as_before() {
    let app = app_with(Providers::new(MockProvider, fast_streaming_planner()), &[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = app
        .router
        .clone()
        .oneshot(request(
            "POST",
            CHAT_URI,
            Some(&cookie),
            Some(chat_body("give me the drums to match")),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert!(response.headers().get(header::CONTENT_LENGTH).is_some());
    assert!(response.headers().get("x-accel-buffering").is_none());
    let body: Value = serde_json::from_str(&read_text(response).await).unwrap();
    assert_eq!(body["reply"], "Added a Drums track.");
    assert_eq!(body["track"]["instrument"], "drums");
    assert_eq!(
        body.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["reply", "track"]
    );
}

/// Virtual time starts after the request is accepted, because paused time would fire the
/// database pool's acquire timeout while the session lookup is still pending.
#[tokio::test]
async fn a_three_minute_silent_provider_call_is_kept_alive_and_changes_nothing() {
    let stall = Duration::from_secs(180);
    let extra = [(GENERATION_TIMEOUT_SECS, "600")];

    let (control, _) = stream_for(
        Providers::new(MockProvider, StalledPlans(Duration::ZERO)),
        &extra,
        "give me the drums to match",
    )
    .await;

    let app = app_with(Providers::new(MockProvider, StalledPlans(stall)), &extra).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = open(&app, &cookie, "give me the drums to match").await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();

    tokio::time::pause();
    let started = tokio::time::Instant::now();
    let mut last = started;
    let mut max_gap = Duration::ZERO;
    let mut comments = 0;
    let mut text = String::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.unwrap();
        let now = tokio::time::Instant::now();
        max_gap = max_gap.max(now - last);
        last = now;
        let chunk = String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap();
        if chunk.starts_with(':') {
            comments += 1;
        }
        text.push_str(&chunk);
    }

    assert!(last - started >= stall - Duration::from_secs(1));
    // A millisecond of slack: the interval is measured from when the stream was first polled.
    assert!(max_gap <= Duration::from_millis(15_100), "{max_gap:?}");
    assert!(comments >= 11, "{comments} keepalives");
    assert_eq!(parse_events(&text), control);
}

#[tokio::test]
async fn dropping_the_client_during_planning_stops_the_request_before_any_generation() {
    let (started, gate, dropped) = (
        Arc::new(Notify::new()),
        Arc::new(Semaphore::new(0)),
        Arc::new(AtomicBool::new(false)),
    );
    let patterns = CountingPatterns::default();
    let plans = GatedPlans {
        started: started.clone(),
        gate: gate.clone(),
        dropped: dropped.clone(),
    };
    let app = app_with(Providers::new(patterns.clone(), plans), &[]).await;
    let cookie = app.cookie_for("ana@example.com").await;

    let response = open(&app, &cookie, "give me the drums to match").await;
    started.notified().await;
    drop(response);

    tokio::time::timeout(Duration::from_secs(5), async {
        while !dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the planner call was dropped with the client");
    gate.add_permits(10);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(patterns.0.load(Ordering::SeqCst), 0);
}

struct Gated {
    app: TestApp,
    cookie: String,
    gate: Arc<Semaphore>,
}

async fn gated_app(limit: usize) -> Gated {
    let (started, gate) = (Arc::new(Notify::new()), Arc::new(Semaphore::new(0)));
    let plans = GatedPlans {
        started,
        gate: gate.clone(),
        dropped: Arc::default(),
    };
    let app = app_with(
        Providers::new(MockProvider, plans),
        &[(MAX_CONCURRENT_GENERATIONS, &limit.to_string())],
    )
    .await;
    let cookie = app.cookie_for("ana@example.com").await;
    Gated { app, cookie, gate }
}

async fn first_event(body: &mut Body) -> String {
    let frame = body.frame().await.unwrap().unwrap();
    String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap()
}

async fn another_request(gated: &Gated) -> common::app::Response {
    gated
        .app
        .send(request(
            "POST",
            CHAT_URI,
            Some(&gated.cookie),
            Some(chat_body("what tempo?")),
        ))
        .await
}

#[tokio::test]
async fn open_streams_hold_their_generation_slots_until_they_end() {
    let gated = gated_app(2).await;
    let mut bodies = Vec::new();
    for _ in 0..2 {
        let mut body = open(&gated.app, &gated.cookie, "what tempo?")
            .await
            .into_body();
        assert!(first_event(&mut body).await.contains("planning"));
        bodies.push(body);
    }

    let busy = another_request(&gated).await;
    assert_eq!(busy.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.body["error"]["code"], "generation_busy");

    gated.gate.add_permits(10);
    for body in bodies {
        let text = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(parse_events(&text).iter().any(|(n, _)| n == "result"));
    }
    assert_eq!(another_request(&gated).await.status, StatusCode::OK);
}

#[tokio::test]
async fn dropped_streams_release_their_generation_slots() {
    let gated = gated_app(1).await;
    let mut body = open(&gated.app, &gated.cookie, "what tempo?")
        .await
        .into_body();
    first_event(&mut body).await;
    assert_eq!(
        another_request(&gated).await.status,
        StatusCode::SERVICE_UNAVAILABLE
    );

    drop(body);
    gated.gate.add_permits(10);
    assert_eq!(another_request(&gated).await.status, StatusCode::OK);
}

struct PanickingPlans;

#[async_trait]
impl PlanProvider for PanickingPlans {
    async fn plan(&self, _: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        panic!("SECRET-PANIC-TEXT");
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[tokio::test]
async fn a_panicking_chat_task_still_ends_the_stream_with_one_fixed_error_event() {
    let providers = Providers::new(MockProvider, PanickingPlans);
    let (events, _) = stream_for(providers, &[], "give me the drums").await;
    assert_eq!(names(&events), ["progress", "error"]);
    assert_eq!(events[1].1["code"], "internal_error");
    assert!(!events[1].1.to_string().contains("SECRET-PANIC-TEXT"));
}

fn claude_plan_stream() -> String {
    let event = |name: &str, data: Value| format!("event: {name}\ndata: {data}\n\n");
    let plan = r#"{"action":"add_track","reply":"ok","instrument":"drums","track_name":"D","prompt":"p","measures":null}"#;
    event(
        "content_block_start",
        json!({"type": "content_block_start", "index": 0,
            "content_block": {"type": "tool_use", "id": "t", "name": "emit_plan", "input": {}}}),
    ) + &event(
        "content_block_delta",
        json!({"type": "content_block_delta", "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": plan}}),
    ) + &event("message_stop", json!({"type": "message_stop"}))
}

async fn claude_app(server: &wiremock::MockServer) -> TestApp {
    let transport = music::ai::ClaudeProvider::new(secrecy::SecretString::from("k"), "m")
        .with_base_url(server.uri());
    app_with(Providers::over(Arc::new(transport)), &[]).await
}

async fn generation_requests(server: &wiremock::MockServer) -> usize {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| String::from_utf8_lossy(&r.body).contains("\"emit_pattern\""))
        .count()
}

async fn slow_planner_server() -> wiremock::MockServer {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/v1/messages"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(600))
                .set_body_string(claude_plan_stream()),
        )
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn a_real_transport_sees_no_generation_request_after_the_client_drops_mid_plan() {
    // Control: left alone, the same planner response leads to a generation request, so the
    // absence below is caused by the drop and not by the fixture.
    let control = slow_planner_server().await;
    let app = claude_app(&control).await;
    let cookie = app.cookie_for("ana@example.com").await;
    read_text(open(&app, &cookie, "give me the drums").await).await;
    assert!(generation_requests(&control).await >= 1);

    let server = slow_planner_server().await;
    let app = claude_app(&server).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = open(&app, &cookie, "give me the drums").await;
    let mut body = response.into_body();
    assert!(first_event(&mut body).await.contains("planning"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.received_requests().await.unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the planner request was sent");
    drop(body);

    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
    assert_eq!(generation_requests(&server).await, 0);
}

#[tokio::test]
async fn a_stream_nobody_reads_does_not_hold_the_generation_slot_after_it_finishes() {
    let gated = gated_app(1).await;
    let mut body = open(&gated.app, &gated.cookie, "what tempo?")
        .await
        .into_body();
    first_event(&mut body).await;
    assert_eq!(
        another_request(&gated).await.status,
        StatusCode::SERVICE_UNAVAILABLE
    );

    gated.gate.add_permits(10);
    // The body is kept alive and never polled again, as a client that stopped reading would.
    tokio::time::timeout(Duration::from_secs(5), async {
        while another_request(&gated).await.status != StatusCode::OK {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the slot was released when the chat work ended");
    drop(body);
}

#[tokio::test]
async fn a_json_chat_never_asks_the_provider_to_stream() {
    let server = wiremock::MockServer::start().await;
    let plan = json!({"action": "add_track", "reply": "ok", "instrument": "drums",
        "track_name": "D", "prompt": "p", "measures": null});
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
            "content": [{"type": "tool_use", "name": "emit_plan", "input": plan}]
        })))
        .mount(&server)
        .await;
    let app = claude_app(&server).await;
    let cookie = app.cookie_for("ana@example.com").await;
    app.send(request(
        "POST",
        CHAT_URI,
        Some(&cookie),
        Some(chat_body("give me the drums")),
    ))
    .await;

    let requests = server.received_requests().await.unwrap();
    assert!(!requests.is_empty());
    for received in requests {
        let sent: Value = received.body_json().unwrap();
        assert_ne!(sent["stream"], true, "{sent}");
    }
}
