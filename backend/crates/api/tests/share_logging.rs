//! One process-wide subscriber captures every thread's logs, and each test
//! looks only for values unique to it, so the tests can run in parallel.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};

use axum::http::StatusCode;
use common::app::TestApp;
use common::share::*;
use serde_json::json;
use tracing_subscriber::fmt::MakeWriter;

static CAPTURED: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();

#[derive(Clone)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Sink {
    type Writer = Sink;
    fn make_writer(&'a self) -> Sink {
        self.clone()
    }
}

fn capture() -> Arc<Mutex<Vec<u8>>> {
    CAPTURED
        .get_or_init(|| {
            let buffer = Arc::new(Mutex::new(Vec::new()));
            // TRACE so that nothing, including dependencies, can log a secret unseen.
            let subscriber = tracing_subscriber::fmt()
                .json()
                .with_max_level(tracing::Level::TRACE)
                .with_current_span(true)
                .with_span_list(true)
                .with_writer(Sink(buffer.clone()))
                .finish();
            tracing::subscriber::set_global_default(subscriber).expect("one global subscriber");
            buffer
        })
        .clone()
}

fn logs(buffer: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&buffer.lock().unwrap()).into_owned()
}

#[tokio::test]
async fn a_listeners_token_and_comment_text_never_reach_the_logs() {
    let buffer = capture();
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("logging-owner-4d1e@example.com").await;
    let project = sectioned_project(&app, &cookie).await;
    let (_, token) = make_share(&app, &cookie, &project, live_body()).await;
    let midi_body = json!({"mode": "live", "expires_at": null, "allow_comments": true,
                           "allow_downloads": true});
    let (_, midi_token) = make_share(&app, &cookie, &project, midi_body).await;
    let name = "Unique-Listener-Name-81b6";
    let text = "unique comment text 5c0f that must stay out of logs";

    let heard = listen(&app, &token).await;
    let posted = post_comment(
        &app,
        &token,
        json!({"name": name, "body": text, "at_step": 3}),
    )
    .await;
    let rejected = post_comment(
        &app,
        &token,
        json!({"name": name, "body": text, "at_step": -1}),
    )
    .await;
    let midi = send_raw(
        &app,
        listen_request(
            "GET",
            &format!("/api/v1/listen/{midi_token}/midi"),
            &[],
            None,
        ),
    )
    .await;
    let unknown = listen(&app, &"Z".repeat(43)).await;
    assert_eq!(heard.status, StatusCode::OK);
    assert_eq!(posted.status, StatusCode::CREATED);
    assert_eq!(rejected.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(midi.status, StatusCode::OK);
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);

    let captured = logs(&buffer);
    for secret in [
        token.as_str(),
        midi_token.as_str(),
        &"Z".repeat(43),
        name,
        text,
    ] {
        assert!(!captured.contains(secret), "log output leaked {secret}");
    }
    for expected in [
        "/api/v1/listen/:token\"",
        "/api/v1/listen/:token/comments",
        "/api/v1/listen/:token/midi",
    ] {
        assert!(
            captured.lines().any(|l| l.contains(expected)),
            "no request line shows {expected}"
        );
    }
}

#[tokio::test]
async fn a_created_token_is_not_logged() {
    let buffer = capture();
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("creating-owner-7a92@example.com").await;
    let project = sectioned_project(&app, &cookie).await;

    let created = create_share(&app, &cookie, &project, live_body()).await;

    assert_eq!(created.status, StatusCode::CREATED);
    let token = created.body["token"].as_str().unwrap();
    let captured = logs(&buffer);
    assert!(!captured.contains(token), "the new token reached the logs");
    assert!(
        captured.contains("share link created"),
        "creation is logged by id"
    );
}
