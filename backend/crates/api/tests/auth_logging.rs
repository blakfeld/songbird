//! One process-wide subscriber captures every thread's logs, and each test
//! looks only for values unique to it, so the tests can run in parallel.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};

use api::auth::session::sha256_hex;
use axum::http::{header, StatusCode};
use common::app::{cookie_pair, login_request, request, TestApp};
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
async fn neither_the_password_nor_the_token_nor_the_email_is_logged_during_login() {
    let buffer = capture();
    let password = "unique-correct-password-7f3a";
    let wrong = "unique-wrong-password-91bc";
    let email = "logging-subject-7f3a@example.com";
    let app = TestApp::new(&[]).await;
    app.create_user(email, password).await;

    let failed = app.send(login_request(email, wrong)).await;
    let ok = app.send(login_request(email, password)).await;
    assert_eq!(failed.status, StatusCode::UNAUTHORIZED);
    assert_eq!(ok.status, StatusCode::OK);
    let set_cookie = ok.headers[header::SET_COOKIE].to_str().unwrap().to_string();
    let token = cookie_pair(&ok).split_once('=').unwrap().1.to_string();
    assert!(set_cookie.contains(&token));

    let captured = logs(&buffer);
    assert!(captured.contains("login failed"), "the failure is logged");
    for secret in [password, wrong, token.as_str(), email] {
        assert!(!captured.contains(secret), "log output leaked {secret}");
    }
    assert!(!captured.contains("Set-Cookie") && !captured.contains("set-cookie"));
}

#[tokio::test]
async fn a_failed_login_line_has_the_address_and_an_email_hash_but_not_the_email() {
    let buffer = capture();
    let email = "hash-subject-b2d4@example.com";
    let app = TestApp::new(&[]).await;

    app.send(login_request(email, "some wrong password")).await;

    let captured = logs(&buffer);
    let line = captured
        .lines()
        .find(|l| l.contains("login failed") && l.contains(&sha256_hex(email)))
        .expect("a failure line carrying the email's hash");
    assert!(line.contains("203.0.113.5"), "{line}");
    assert!(!line.contains(email));
}

#[tokio::test]
async fn an_authenticated_requests_records_carry_the_user_id_and_not_the_email() {
    let buffer = capture();
    let email = "traced-subject-c9e1@example.com";
    let app = TestApp::new(&[]).await;
    let user = app.create_user(email, "a long enough password").await;
    let cookie = app.cookie_for(email).await;

    let response = app
        .send(request("GET", "/api/v1/projects", Some(&cookie), None))
        .await;
    assert_eq!(response.status, StatusCode::OK);

    let captured = logs(&buffer);
    let tagged = format!("\"user_id\":\"{}\"", user.id);
    assert!(
        captured
            .lines()
            .any(|l| l.contains(&tagged) && l.contains("/api/v1/projects")),
        "no request record carries the user id"
    );
    assert!(!captured.contains(email), "the email reached the logs");
    let token = cookie.split_once('=').unwrap().1;
    assert!(
        !captured.contains(token),
        "the session token reached the logs"
    );
}
