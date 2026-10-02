//! A submitted or stored key must never reach a log line, a span field, a response, or a
//! `Debug` rendering. Every path that handles a key is driven with sentinel keys, and any
//! 8-character window of a sentinel found in the output fails the test.

mod common;

use std::fmt::{Debug, Write as _};
use std::sync::{Arc, Mutex};

use api::ai_access::{AiAccess, MockUserProviders, RealUserProviders, UserProviders};
use api::cli::rotate_keys;
use api::config::{Config, Keyring, AI_PROVIDER, ENV, MASTER_KEYS};
use api::keys::UserApiKey;
use api::provider::Providers;
use api::state::AppState;
use axum::body::Body;
use axum::http::{header, Request};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use common::app::{request, Response, TestApp};
use http_body_util::BodyExt;
use music::ai::{ClaudeProvider, OpenAiProvider};
use secrecy::SecretString;
use serde_json::{json, Value};
use tower::ServiceExt;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Record};
use tracing::{Event, Id, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use wiremock::matchers::any;
use wiremock::{Mock, MockServer, Request as MockRequest, Respond, ResponseTemplate};

const TAIL: &str = "LEAKSENTINEL-Zq7Xv9Kp2Wm4Rt6Yb8";
const NUMBER_SENTINEL: &str = "98765432109876543210";

fn anthropic(suffix: &str) -> String {
    format!("sk-ant-{TAIL}{suffix}")
}

fn openai(suffix: &str) -> String {
    format!("sk-proj-{TAIL}{suffix}")
}

/// Records everything a subscriber is shown: event fields, span creation, and fields recorded
/// onto a span after it was created.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<String>>);

struct Writer<'a>(&'a mut String);

impl Visit for Writer<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        let _ = write!(self.0, " {}={value:?}", field.name());
    }
}

impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for Capture {
    fn on_new_span(&self, attrs: &Attributes<'_>, _: &Id, _: Context<'_, S>) {
        let mut out = self.0.lock().unwrap();
        let _ = write!(out, "\nspan {}", attrs.metadata().name());
        attrs.record(&mut Writer(&mut out));
    }

    fn on_record(&self, _: &Id, values: &Record<'_>, _: Context<'_, S>) {
        let mut out = self.0.lock().unwrap();
        out.push_str("\nrecord");
        values.record(&mut Writer(&mut out));
    }

    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let mut out = self.0.lock().unwrap();
        let _ = write!(out, "\nevent {}", event.metadata().target());
        event.record(&mut Writer(&mut out));
    }
}

fn windows(secret: &str) -> impl Iterator<Item = String> + '_ {
    let chars: Vec<char> = secret.chars().collect();
    (0..chars.len().saturating_sub(7)).map(move |i| chars[i..i + 8].iter().collect())
}

fn assert_no_window(haystack: &str, secret: &str, place: &str) {
    for window in windows(secret) {
        assert!(
            !haystack.contains(&window),
            "{place} contains \"{window}\" from a key"
        );
    }
}

/// Everything a client could see: bodies and every header name and value.
#[derive(Default)]
struct Observed(Vec<String>);

impl Observed {
    fn record(&mut self, response: &Response) {
        self.0.push(response.body.to_string());
        for (name, value) in &response.headers {
            self.0
                .push(format!("{name}: {}", value.to_str().unwrap_or("")));
        }
    }
}

/// Answers like a provider that quotes the caller's credential back in its error text,
/// which is the worst case for anything that forwards or logs an upstream body.
struct Echo {
    openai: bool,
}

impl Respond for Echo {
    fn respond(&self, req: &MockRequest) -> ResponseTemplate {
        let credential = req
            .headers
            .get("x-api-key")
            .or_else(|| req.headers.get("authorization"))
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let ends = |suffix: &str| credential.ends_with(suffix);
        let message = format!("invalid credential {credential}");
        let anthropic_error =
            |kind: &str| json!({"type": "error", "error": {"type": kind, "message": message}});
        let openai_error = |kind: &str, code: &str| json!({"error": {"message": message, "type": kind, "code": code}});

        if req.url.path().ends_with("/models") {
            return if ends("-rejected") {
                ResponseTemplate::new(401).set_body_string(message)
            } else if ends("-unreachable") {
                ResponseTemplate::new(503).set_body_string(message)
            } else {
                ResponseTemplate::new(200).set_body_json(json!({"data": []}))
            };
        }
        if ends("-revoked") {
            let body = if self.openai {
                openai_error("invalid_request_error", "invalid_api_key")
            } else {
                anthropic_error("authentication_error")
            };
            ResponseTemplate::new(401).set_body_json(body)
        } else if ends("-ratelimited") {
            let body = if self.openai {
                openai_error("requests", "rate_limit_exceeded")
            } else {
                anthropic_error("rate_limit_error")
            };
            ResponseTemplate::new(429)
                .insert_header("retry-after", "5")
                .set_body_json(body)
        } else if ends("-quota") {
            if self.openai {
                ResponseTemplate::new(429)
                    .set_body_json(openai_error("insufficient_quota", "insufficient_quota"))
            } else {
                ResponseTemplate::new(402).set_body_json(anthropic_error("billing_error"))
            }
        } else {
            let draft = json!({"name": "G", "sections": [{"id": "A", "lanes": [{"lane": "kick", "steps": "x..."}]}], "arrangement": ["A"]});
            if self.openai {
                ResponseTemplate::new(200).set_body_json(json!({
                    "choices": [{"message": {"content": draft.to_string()}, "finish_reason": "stop"}]
                }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "content": [{"type": "tool_use", "name": "emit_pattern", "input": draft}]
                }))
            }
        }
    }
}

const KEYRING: &str = "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async fn app_over(factory: Arc<dyn UserProviders>) -> TestApp {
    TestApp::with_state(&[(MASTER_KEYS, KEYRING)], |state| {
        state.ai = AiAccess::PerUser(factory);
    })
    .await
}

async fn send(app: &TestApp, observed: &mut Observed, request: Request<Body>) -> Response {
    let response = app.send(request).await;
    observed.record(&response);
    response
}

async fn put_key(
    app: &TestApp,
    observed: &mut Observed,
    cookie: &str,
    provider: &str,
    key: &str,
) -> Response {
    let body = json!({"key": key});
    send(
        app,
        observed,
        request(
            "PUT",
            &format!("/api/v1/account/ai-keys/{provider}"),
            Some(cookie),
            Some(body),
        ),
    )
    .await
}

fn ai_routes() -> Vec<(&'static str, Value)> {
    vec![
        (
            "/api/v1/patterns/generate",
            json!({"instrument": "drums", "prompt": "four on the floor", "measures": 4}),
        ),
        (
            "/api/v1/songs/tracks/generate",
            json!({"song": common::app::song("Late Train", 1), "track_id": "t0", "prompt": "busier"}),
        ),
        (
            "/api/v1/songs/chat",
            json!({"song": common::app::song("Late Train", 1), "messages": [{"role": "user", "content": "add a bass line"}]}),
        ),
    ]
}

/// The streamed chat reports provider failures as events inside a 200 response, so its raw
/// text, which `Response` would parse as JSON and lose, is recorded too.
async fn send_streamed_chat(app: &TestApp, observed: &mut Observed, cookie: &str) {
    let mut req = request(
        "POST",
        "/api/v1/songs/chat",
        Some(cookie),
        Some(
            json!({"song": common::app::song("Late Train", 1), "messages": [{"role": "user", "content": "add a bass line"}]}),
        ),
    );
    req.headers_mut()
        .insert(header::ACCEPT, "text/event-stream".parse().unwrap());
    let response = app.router.clone().oneshot(req).await.unwrap();
    for (name, value) in response.headers() {
        observed
            .0
            .push(format!("{name}: {}", value.to_str().unwrap_or("")));
    }
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    observed
        .0
        .push(String::from_utf8_lossy(&bytes).into_owned());
}

/// Saves keys and drives every AI route, key removal and provider switch for users whose keys
/// make the provider (real or mock) succeed or fail in each documented way.
async fn drive(app: &TestApp, observed: &mut Observed) {
    for (index, suffix) in ["", "-revoked", "-ratelimited", "-quota"]
        .into_iter()
        .enumerate()
    {
        let cookie = app.cookie_for(&format!("user{index}@example.com")).await;
        let saved = put_key(app, observed, &cookie, "anthropic", &anthropic(suffix)).await;
        assert_eq!(saved.status.as_u16(), 200, "{suffix}: {:?}", saved.body);
        for (uri, body) in ai_routes() {
            send(
                app,
                observed,
                request("POST", uri, Some(&cookie), Some(body)),
            )
            .await;
        }
        send_streamed_chat(app, observed, &cookie).await;
    }

    let both = app.cookie_for("both@example.com").await;
    put_key(app, observed, &both, "anthropic", &anthropic("")).await;
    put_key(app, observed, &both, "openai", &openai("-quota")).await;
    send(
        app,
        observed,
        request(
            "PUT",
            "/api/v1/account/ai-provider",
            Some(&both),
            Some(json!({"provider": "openai"})),
        ),
    )
    .await;
    for (uri, body) in ai_routes() {
        send(app, observed, request("POST", uri, Some(&both), Some(body))).await;
    }
    send_streamed_chat(app, observed, &both).await;
    for suffix in ["", "-revoked", "-ratelimited"] {
        let cookie = app.cookie_for(&format!("oa{suffix}@example.com")).await;
        put_key(app, observed, &cookie, "openai", &openai(suffix)).await;
        for (uri, body) in ai_routes() {
            send(
                app,
                observed,
                request("POST", uri, Some(&cookie), Some(body)),
            )
            .await;
        }
        send_streamed_chat(app, observed, &cookie).await;
    }
    send(
        app,
        observed,
        request("GET", "/api/v1/account/ai-keys", Some(&both), None),
    )
    .await;
    for provider in ["anthropic", "openai"] {
        send(
            app,
            observed,
            request(
                "DELETE",
                &format!("/api/v1/account/ai-keys/{provider}"),
                Some(&both),
                None,
            ),
        )
        .await;
    }

    let rejected = app.cookie_for("rejected@example.com").await;
    put_key(
        app,
        observed,
        &rejected,
        "anthropic",
        &anthropic("-rejected"),
    )
    .await;
    put_key(app, observed, &rejected, "openai", &openai("-unreachable")).await;
    put_key(
        app,
        observed,
        &rejected,
        "anthropic",
        &format!("{TAIL} too short"),
    )
    .await;

    let malformed = app.cookie_for("malformed@example.com").await;
    for raw in [
        format!(r#"{{"key": {NUMBER_SENTINEL}}}"#),
        format!(r#"{{"key": "{}", "extra": 1}}"#, anthropic("")),
        format!(r#"{{"apikey": "{}"}}"#, anthropic("")),
        format!("not json {}", anthropic("")),
        format!(r#"{{"key": ["{}"]}}"#, anthropic("")),
    ] {
        let response = send(
            app,
            observed,
            Request::put("/api/v1/account/ai-keys/anthropic")
                .header(header::COOKIE, &malformed)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(raw))
                .unwrap(),
        )
        .await;
        assert_eq!(response.status.as_u16(), 400);
    }
}

/// A misbehaving provider must not see its own echo come back out of our responses or logs.
#[tokio::test]
async fn no_key_reaches_a_log_a_response_or_a_debug_rendering() {
    let capture = Capture::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(capture.clone()));
    let mut observed = Observed::default();

    let mock_app = app_over(Arc::new(MockUserProviders)).await;
    drive(&mock_app, &mut observed).await;

    let (anthropic_server, openai_server) = (MockServer::start().await, MockServer::start().await);
    Mock::given(any())
        .respond_with(Echo { openai: false })
        .mount(&anthropic_server)
        .await;
    Mock::given(any())
        .respond_with(Echo { openai: true })
        .mount(&openai_server)
        .await;
    let config = Config::from_lookup(|k| match k {
        ENV => Some("development".into()),
        AI_PROVIDER => Some("mock".into()),
        _ => None,
    })
    .unwrap();
    let real =
        RealUserProviders::new(&config).with_base_urls(anthropic_server.uri(), openai_server.uri());
    let real_debug = format!("{real:?}{real:#?}");
    let real_app = app_over(Arc::new(real)).await;
    drive(&real_app, &mut observed).await;

    // Rotation touches every stored key, so its output and logs are checked as well.
    let rotated = Keyring::parse(&format!("v2:{},{KEYRING}", BASE64.encode([2u8; 32]))).unwrap();
    observed
        .0
        .push(rotate_keys(real_app.db(), &rotated).await.unwrap());

    assert!(
        !observed.0.is_empty() && capture.0.lock().unwrap().len() > 1000,
        "the test drove nothing"
    );
    // Suffixes such as "-rejected" are ordinary words that legitimately appear in error codes,
    // so only the unique part of each key is searched for; a leaked key contains it too.
    let secrets = [
        anthropic(""),
        openai(""),
        TAIL.to_string(),
        NUMBER_SENTINEL.to_string(),
    ];
    let logs = capture.0.lock().unwrap().clone();
    let responses = observed.0.join("\n");
    for secret in &secrets {
        assert_no_window(&logs, secret, "the captured logs");
        assert_no_window(&responses, secret, "a response body or header");
        assert_no_window(&real_debug, secret, "the factory's Debug output");
    }
}

#[test]
fn debug_output_of_every_type_that_holds_a_key_or_master_key_is_clean() {
    let key = anthropic("");
    let raw_master = [0xA5u8; 32];
    let encoded_master = BASE64.encode(raw_master);
    let config = Config::from_lookup(|k| match k {
        ENV => Some("development".into()),
        AI_PROVIDER => Some("mock".into()),
        MASTER_KEYS => Some(format!("v1:{encoded_master}")),
        _ => None,
    })
    .unwrap();
    let keyring = config.master_keys.clone().unwrap();

    let mut renderings = vec![
        format!("{config:?}{config:#?}"),
        format!("{keyring:?}{keyring:#?}"),
        format!("{:?}", UserApiKey::new(key.clone())),
        format!(
            "{:?}",
            ClaudeProvider::new(SecretString::from(key.clone()), "m")
        ),
        format!(
            "{:?}",
            OpenAiProvider::new(SecretString::from(openai("")), "m")
        ),
        format!("{:?}", RealUserProviders::new(&config)),
        format!("{:?}", MockUserProviders),
    ];
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let db = common::db::sqlite_test_db().await;
        let state = AppState::new(
            Providers::mock(),
            music::InstrumentRegistry::builtin(),
            Arc::new(config.clone()),
            (*db).clone(),
        );
        renderings.push(format!("{state:?}{state:#?}"));
    });

    let joined = renderings.join("\n");
    assert!(joined.contains("v1"), "versions are shown");
    assert_no_window(&joined, &key, "a Debug rendering");
    assert_no_window(&joined, &openai(""), "a Debug rendering");
    assert_no_window(&joined, &encoded_master, "a Debug rendering");
    assert_no_window(&joined, &format!("{raw_master:?}"), "a Debug rendering");
    assert!(!joined.contains("[165, 165, 165, 165"), "raw key bytes");
}
