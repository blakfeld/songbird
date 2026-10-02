//! Per-user AI access: which key serves a request, what happens without one, and how a
//! provider's failure with that key is reported.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use api::ai_access::{AiAccess, MockUserProviders, RealUserProviders, UserProviders};
use api::config::{AI_REQUESTS_PER_MINUTE, MASTER_KEYS};
use api::keys::{self, AiProvider, UserApiKey};
use api::provider::Providers;
use async_trait::async_trait;
use axum::http::{header, StatusCode};
use common::app::{request, song, Response, TestApp};
use music::ai::KeyCheckError;
use serde_json::{json, Value};
use wiremock::matchers::{header as header_is, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const KEYRING: &str = "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ANTHROPIC_KEY: &str = "sk-ant-api03-anthropic-key-alpha";
const OPENAI_KEY: &str = "sk-proj-openai-key-bravo-1234";

const GOOD_DRAFT: &str = r#"{"name":"Groove","sections":[{"id":"A","lanes":[{"lane":"kick","steps":"x..."}]}],"arrangement":["A"]}"#;

fn generate_body() -> Value {
    json!({"instrument": "drums", "prompt": "four on the floor", "measures": 4})
}

fn ai_routes() -> Vec<(&'static str, Value)> {
    vec![
        ("/api/v1/patterns/generate", generate_body()),
        (
            "/api/v1/songs/tracks/generate",
            json!({"song": song("Late Train", 1), "track_id": "t0", "prompt": "busier"}),
        ),
        (
            "/api/v1/songs/chat",
            json!({"song": song("Late Train", 1), "messages": [{"role": "user", "content": "hello there"}]}),
        ),
    ]
}

/// Tests assert on bundle count because a request refused before key resolution must build none,
/// which proves no provider could have been called.
struct CountingFactory {
    inner: Arc<dyn UserProviders>,
    built: Arc<AtomicUsize>,
}

#[async_trait]
impl UserProviders for CountingFactory {
    fn providers(&self, provider: AiProvider, key: UserApiKey) -> Providers {
        self.built.fetch_add(1, Ordering::SeqCst);
        self.inner.providers(provider, key)
    }

    async fn check_key(&self, provider: AiProvider, key: &UserApiKey) -> Result<(), KeyCheckError> {
        self.inner.check_key(provider, key).await
    }
}

struct Harness {
    app: TestApp,
    built: Arc<AtomicUsize>,
}

async fn harness_over(
    factory: Arc<dyn UserProviders>,
    extra: &[(&'static str, &'static str)],
) -> Harness {
    let built = Arc::new(AtomicUsize::new(0));
    let counting = Arc::new(CountingFactory {
        inner: factory,
        built: built.clone(),
    });
    let mut pairs = vec![(MASTER_KEYS, KEYRING)];
    pairs.extend_from_slice(extra);
    let app = TestApp::with_state(&pairs, |state| {
        state.ai = AiAccess::PerUser(counting);
    })
    .await;
    Harness { app, built }
}

async fn mock_harness(extra: &[(&'static str, &'static str)]) -> Harness {
    harness_over(Arc::new(MockUserProviders), extra).await
}

async fn wiremock_harness(anthropic: &MockServer, openai: &MockServer) -> Harness {
    let real =
        RealUserProviders::new(&config_for_models()).with_base_urls(anthropic.uri(), openai.uri());
    harness_over(Arc::new(real), &[]).await
}

fn config_for_models() -> api::config::Config {
    api::config::Config::from_lookup(|k| match k {
        api::config::ENV => Some("development".into()),
        api::config::AI_PROVIDER => Some("mock".into()),
        _ => None,
    })
    .unwrap()
}

impl Harness {
    async fn user_with_key(&self, email: &str, provider: AiProvider, key: &str) -> String {
        let cookie = self.app.cookie_for(email).await;
        let user = api::users::find_by_email(self.app.db(), email)
            .await
            .unwrap()
            .unwrap();
        let ring = self.app.state.config.master_keys.as_ref().unwrap();
        let key = UserApiKey::new(key.to_string());
        let sealed = keys::encrypt(ring, &user.id, provider, &key).unwrap();
        keys::upsert(self.app.db(), &user.id, provider, &sealed, &key.last4())
            .await
            .unwrap();
        cookie
    }

    async fn post(&self, cookie: &str, uri: &str, body: &Value) -> Response {
        self.app
            .send(request("POST", uri, Some(cookie), Some(body.clone())))
            .await
    }
}

fn anthropic_ok() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "content": [{"type": "tool_use", "name": "emit_pattern",
                     "input": serde_json::from_str::<Value>(GOOD_DRAFT).unwrap()}]
    }))
}

fn openai_ok() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "choices": [{"message": {"role": "assistant", "content": GOOD_DRAFT}, "finish_reason": "stop"}]
    }))
}

#[tokio::test]
async fn a_user_without_a_key_gets_409_on_every_ai_route_and_no_provider_is_called() {
    let (anthropic, openai) = (MockServer::start().await, MockServer::start().await);
    for (uri, body) in ai_routes() {
        let h = wiremock_harness(&anthropic, &openai).await;
        let cookie = h.app.cookie_for("ana@example.com").await;
        let response = h.post(&cookie, uri, &body).await;
        assert_eq!(response.status, StatusCode::CONFLICT, "{uri}");
        assert_eq!(response.body["error"]["code"], "api_key_required");
        assert_eq!(h.built.load(Ordering::SeqCst), 0);
    }
    assert!(anthropic.received_requests().await.unwrap().is_empty());
    assert!(openai.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_missing_key_wins_over_a_malformed_body() {
    let h = mock_harness(&[]).await;
    let cookie = h.app.cookie_for("ana@example.com").await;
    let response = h
        .post(
            &cookie,
            "/api/v1/patterns/generate",
            &json!({"nonsense": 1}),
        )
        .await;
    assert_eq!(response.body["error"]["code"], "api_key_required");
}

#[tokio::test]
async fn the_active_providers_request_carries_that_users_key() {
    let (anthropic, openai) = (MockServer::start().await, MockServer::start().await);
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header_is("x-api-key", ANTHROPIC_KEY))
        .respond_with(anthropic_ok())
        .expect(1)
        .mount(&anthropic)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header_is(
            "authorization",
            format!("Bearer {OPENAI_KEY}").as_str(),
        ))
        .respond_with(openai_ok())
        .expect(1)
        .mount(&openai)
        .await;
    let h = wiremock_harness(&anthropic, &openai).await;
    let ana = h
        .user_with_key("ana@example.com", AiProvider::Anthropic, ANTHROPIC_KEY)
        .await;
    let bo = h
        .user_with_key("bo@example.com", AiProvider::Openai, OPENAI_KEY)
        .await;

    let body = generate_body();
    let (a, b) = tokio::join!(
        h.post(&ana, "/api/v1/patterns/generate", &body),
        h.post(&bo, "/api/v1/patterns/generate", &body),
    );
    assert_eq!(a.status, StatusCode::OK, "{:?}", a.body);
    assert_eq!(b.status, StatusCode::OK, "{:?}", b.body);
    // The mounts above only match the right key, and `expect(1)` verifies on drop that each
    // vendor saw exactly its own user's request.
}

async fn failing_provider(
    provider: AiProvider,
    key: &str,
    status: u16,
    body: Value,
    retry_after: Option<&str>,
) -> (Response, usize) {
    let (anthropic, openai) = (MockServer::start().await, MockServer::start().await);
    let mut response = ResponseTemplate::new(status).set_body_json(body);
    if let Some(value) = retry_after {
        response = response.insert_header("retry-after", value);
    }
    let server = match provider {
        AiProvider::Anthropic => &anthropic,
        AiProvider::Openai => &openai,
    };
    Mock::given(method("POST"))
        .respond_with(response)
        .mount(server)
        .await;
    let h = wiremock_harness(&anthropic, &openai).await;
    let cookie = h.user_with_key("ana@example.com", provider, key).await;
    let result = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    let hits = server.received_requests().await.unwrap().len();
    (result, hits)
}

fn text_of(response: &Response) -> String {
    response.body["error"]["message"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_rejected_key_is_409_api_key_invalid_naming_the_provider_and_is_not_retried() {
    let body = json!({"type": "error", "error": {"type": "authentication_error", "message": "LEAKED-TEXT"}});
    let (response, hits) =
        failing_provider(AiProvider::Anthropic, ANTHROPIC_KEY, 401, body, None).await;
    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.body["error"]["code"], "api_key_invalid");
    let message = text_of(&response);
    assert!(
        message.contains("Anthropic") && message.contains("Replace"),
        "{message}"
    );
    assert!(!message.contains("LEAKED-TEXT"));
    assert_eq!(hits, 1);
}

#[tokio::test]
async fn an_exhausted_account_is_409_api_key_quota_exhausted() {
    let body = json!({"error": {"message": "LEAKED-TEXT", "type": "insufficient_quota", "code": "insufficient_quota"}});
    let (response, hits) = failing_provider(AiProvider::Openai, OPENAI_KEY, 429, body, None).await;
    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.body["error"]["code"], "api_key_quota_exhausted");
    let message = text_of(&response);
    assert!(
        message.contains("OpenAI") && message.contains("billing"),
        "{message}"
    );
    assert!(!message.contains("LEAKED-TEXT"));
    assert_eq!(hits, 1);
}

#[tokio::test]
async fn a_rate_limited_key_is_429_with_the_providers_retry_after() {
    let body = json!({"type": "error", "error": {"type": "rate_limit_error", "message": "x"}});
    let (response, hits) =
        failing_provider(AiProvider::Anthropic, ANTHROPIC_KEY, 429, body, Some("20")).await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.body["error"]["code"], "api_key_rate_limited");
    assert_eq!(response.headers[header::RETRY_AFTER], "20");
    assert!(text_of(&response).contains("Anthropic"));
    assert_eq!(hits, 1);
}

#[tokio::test]
async fn a_rate_limit_without_a_delay_sends_no_retry_after() {
    let body =
        json!({"error": {"message": "x", "type": "requests", "code": "rate_limit_exceeded"}});
    let (response, _) = failing_provider(AiProvider::Openai, OPENAI_KEY, 429, body, None).await;
    assert_eq!(response.body["error"]["code"], "api_key_rate_limited");
    assert!(response.headers.get(header::RETRY_AFTER).is_none());
}

#[tokio::test]
async fn other_provider_failures_stay_the_generic_generation_error() {
    let (response, _) = failing_provider(
        AiProvider::Anthropic,
        ANTHROPIC_KEY,
        500,
        json!({"type": "error", "error": {"type": "api_error", "message": "x"}}),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_GATEWAY);
    assert_eq!(response.body["error"]["code"], "generation_failed");
}

#[tokio::test]
async fn ciphertext_copied_to_another_user_fails_with_409_and_calls_no_provider() {
    let (anthropic, openai) = (MockServer::start().await, MockServer::start().await);
    let h = wiremock_harness(&anthropic, &openai).await;
    let ana_cookie = h
        .user_with_key("ana@example.com", AiProvider::Anthropic, ANTHROPIC_KEY)
        .await;
    let bo_cookie = h.app.cookie_for("bo@example.com").await;
    let ana = api::users::find_by_email(h.app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    let bo = api::users::find_by_email(h.app.db(), "bo@example.com")
        .await
        .unwrap()
        .unwrap();
    let stored = keys::active_key(h.app.db(), &ana.id)
        .await
        .unwrap()
        .unwrap();
    keys::upsert(
        h.app.db(),
        &bo.id,
        AiProvider::Anthropic,
        &stored.encrypted,
        "alph",
    )
    .await
    .unwrap();

    let bo_response = h
        .post(&bo_cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(bo_response.status, StatusCode::CONFLICT);
    assert_eq!(bo_response.body["error"]["code"], "api_key_invalid");
    assert!(anthropic.received_requests().await.unwrap().is_empty());
    let _ = ana_cookie;
}

#[tokio::test]
async fn a_stored_version_missing_from_the_keyring_is_api_key_invalid() {
    let h = mock_harness(&[]).await;
    let cookie = h.app.cookie_for("ana@example.com").await;
    let user = api::users::find_by_email(h.app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    let ring = h.app.state.config.master_keys.as_ref().unwrap();
    let key = UserApiKey::new(ANTHROPIC_KEY.to_string());
    let mut sealed = keys::encrypt(ring, &user.id, AiProvider::Anthropic, &key).unwrap();
    sealed.key_version = "v0".into();
    keys::upsert(h.app.db(), &user.id, AiProvider::Anthropic, &sealed, "alph")
        .await
        .unwrap();
    let response = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(response.body["error"]["code"], "api_key_invalid");
}

#[tokio::test]
async fn one_chat_request_builds_one_bundle_for_both_provider_calls() {
    let h = mock_harness(&[]).await;
    let cookie = h
        .user_with_key(
            "ana@example.com",
            AiProvider::Anthropic,
            "sk-ant-test-0000000000ok",
        )
        .await;
    let body = json!({"song": song("Late Train", 1),
        "messages": [{"role": "user", "content": "add a bass line"}]});
    let response = h.post(&cookie, "/api/v1/songs/chat", &body).await;
    assert_eq!(response.status, StatusCode::OK, "{:?}", response.body);
    assert!(response.body["track"].is_object(), "{:?}", response.body);
    assert_eq!(h.built.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_mock_keys_ending_decides_the_outcome_with_no_network() {
    let cases = [
        ("sk-ant-test-0000000000ok", StatusCode::OK, "", None),
        (
            "sk-ant-test-revoked",
            StatusCode::CONFLICT,
            "api_key_invalid",
            None,
        ),
        (
            "sk-ant-test-quota",
            StatusCode::CONFLICT,
            "api_key_quota_exhausted",
            None,
        ),
        (
            "sk-ant-test-ratelimited",
            StatusCode::TOO_MANY_REQUESTS,
            "api_key_rate_limited",
            Some("5"),
        ),
    ];
    for (key, status, code, retry_after) in cases {
        let h = mock_harness(&[]).await;
        let cookie = h
            .user_with_key("ana@example.com", AiProvider::Anthropic, key)
            .await;
        for (uri, body) in ai_routes() {
            let response = h.post(&cookie, uri, &body).await;
            assert_eq!(response.status, status, "{key} {uri} {:?}", response.body);
            if !code.is_empty() {
                assert_eq!(response.body["error"]["code"], code, "{key} {uri}");
            }
            assert_eq!(
                response
                    .headers
                    .get(header::RETRY_AFTER)
                    .map(|v| v.to_str().unwrap()),
                retry_after,
                "{key} {uri}"
            );
        }
    }
}

#[tokio::test]
async fn the_mock_factory_checks_keys_by_their_ending() {
    let check = |key: &'static str| async move {
        MockUserProviders
            .check_key(AiProvider::Anthropic, &UserApiKey::new(key.to_string()))
            .await
    };
    assert_eq!(check("sk-ant-test-0000000000ok").await, Ok(()));
    assert_eq!(check("sk-ant-test-revoked").await, Ok(()));
    assert_eq!(
        check("sk-ant-test-rejected").await,
        Err(KeyCheckError::Rejected)
    );
    assert_eq!(
        check("sk-ant-test-unreachable").await,
        Err(KeyCheckError::Unreachable)
    );
}

#[tokio::test]
async fn the_ai_rate_limit_runs_before_key_resolution_so_a_429_calls_no_provider() {
    let h = mock_harness(&[(AI_REQUESTS_PER_MINUTE, "1")]).await;
    let cookie = h
        .user_with_key(
            "ana@example.com",
            AiProvider::Anthropic,
            "sk-ant-test-0000000000ok",
        )
        .await;
    let first = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(h.built.load(Ordering::SeqCst), 1);

    let second = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(second.body["error"]["code"], "too_many_requests");
    assert_eq!(h.built.load(Ordering::SeqCst), 1);

    // Even a user with no key is metered first, so the limit cannot be probed around.
    let keyless = h.app.cookie_for("bo@example.com").await;
    let once = h
        .post(&keyless, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(once.body["error"]["code"], "api_key_required");
    let twice = h
        .post(&keyless, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(twice.body["error"]["code"], "too_many_requests");
}

#[tokio::test]
async fn the_shared_provider_path_still_serves_users_without_keys() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = app
        .send(request(
            "POST",
            "/api/v1/patterns/generate",
            Some(&cookie),
            Some(generate_body()),
        ))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(app.calls(), 1);
}

#[tokio::test]
async fn startup_in_user_mode_contacts_no_provider() {
    use api::config::{Config, AI_PROVIDER, DATABASE_URL, ENV};
    let db = common::db::test_db().await;
    let url = db.url().to_string();
    for provider in ["user", "user-mock"] {
        let config = Config::from_lookup(|k| match k {
            ENV => Some("production".into()),
            AI_PROVIDER if provider == "user-mock" => Some("user-mock".into()),
            MASTER_KEYS => Some(KEYRING.into()),
            DATABASE_URL => Some(url.clone()),
            _ => None,
        });
        // `user-mock` is development only, so production rejects it before startup.
        let config = match (provider, config) {
            ("user", Ok(config)) => config,
            ("user-mock", Err(_)) => Config::from_lookup(|k| match k {
                ENV => Some("development".into()),
                AI_PROVIDER => Some("user-mock".into()),
                MASTER_KEYS => Some(KEYRING.into()),
                DATABASE_URL => Some(url.clone()),
                _ => None,
            })
            .unwrap(),
            (_, other) => panic!("unexpected config result {other:?}"),
        };
        let state = api::startup::build_state(config).await.unwrap();
        assert!(matches!(state.ai, AiAccess::PerUser(_)), "{provider}");
    }
}

#[test]
fn the_factory_debug_output_holds_no_key_material() {
    let real = RealUserProviders::new(&config_for_models());
    let text = format!("{real:?}");
    assert!(!text.contains("sk-"), "{text}");
    let key = UserApiKey::new(ANTHROPIC_KEY.to_string());
    assert!(!format!("{key:?}").contains(key.expose_secret()));
}

#[tokio::test]
async fn requests_that_end_for_lack_of_a_usable_key_do_not_spend_the_daily_quota() {
    use api::config::{AI_REQUESTS_PER_DAY, AI_REQUESTS_PER_MINUTE};
    let h = mock_harness(&[(AI_REQUESTS_PER_DAY, "2"), (AI_REQUESTS_PER_MINUTE, "600")]).await;
    let cookie = h.app.cookie_for("ana@example.com").await;
    for _ in 0..6 {
        let response = h
            .post(&cookie, "/api/v1/patterns/generate", &generate_body())
            .await;
        assert_eq!(response.body["error"]["code"], "api_key_required");
    }

    // Both refusals happen before any provider call, so neither may cost quota.
    let user = api::users::find_by_email(h.app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    let ring = h.app.state.config.master_keys.as_ref().unwrap();
    let key = UserApiKey::new(ANTHROPIC_KEY.to_string());
    let mut sealed = keys::encrypt(ring, &user.id, AiProvider::Anthropic, &key).unwrap();
    sealed.key_version = "v0".into();
    keys::upsert(h.app.db(), &user.id, AiProvider::Anthropic, &sealed, "alph")
        .await
        .unwrap();
    for _ in 0..3 {
        let response = h
            .post(&cookie, "/api/v1/patterns/generate", &generate_body())
            .await;
        assert_eq!(response.body["error"]["code"], "api_key_invalid");
    }

    let saved = h
        .app
        .send(request(
            "PUT",
            "/api/v1/account/ai-keys/anthropic",
            Some(&cookie),
            Some(json!({"key": "sk-ant-test-0000000000ok"})),
        ))
        .await;
    assert_eq!(saved.status, StatusCode::OK);
    for _ in 0..2 {
        let served = h
            .post(&cookie, "/api/v1/patterns/generate", &generate_body())
            .await;
        assert_eq!(served.status, StatusCode::OK, "{:?}", served.body);
    }
    // The quota is still enforced for requests that do reach a provider.
    let over = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(over.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(h.built.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_provider_rejection_is_still_charged_so_a_revoked_key_gets_no_free_attempts() {
    use api::config::{AI_REQUESTS_PER_DAY, AI_REQUESTS_PER_MINUTE};
    let h = mock_harness(&[(AI_REQUESTS_PER_DAY, "2"), (AI_REQUESTS_PER_MINUTE, "600")]).await;
    let cookie = h
        .user_with_key(
            "ana@example.com",
            AiProvider::Anthropic,
            "sk-ant-test-0000-revoked",
        )
        .await;
    for _ in 0..2 {
        let response = h
            .post(&cookie, "/api/v1/patterns/generate", &generate_body())
            .await;
        assert_eq!(response.body["error"]["code"], "api_key_invalid");
    }
    let over = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(over.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(h.built.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn two_openai_users_hitting_one_openai_server_each_send_their_own_key() {
    let (anthropic, openai) = (MockServer::start().await, MockServer::start().await);
    let (ana_key, bo_key) = ("sk-proj-ana-key-0000000001", "sk-proj-bo-key-00000000002");
    for key in [ana_key, bo_key] {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header_is("authorization", format!("Bearer {key}").as_str()))
            .respond_with(openai_ok())
            .expect(1)
            .mount(&openai)
            .await;
    }
    let h = wiremock_harness(&anthropic, &openai).await;
    let ana = h
        .user_with_key("ana@example.com", AiProvider::Openai, ana_key)
        .await;
    let bo = h
        .user_with_key("bo@example.com", AiProvider::Openai, bo_key)
        .await;
    let body = generate_body();
    let (a, b) = tokio::join!(
        h.post(&ana, "/api/v1/patterns/generate", &body),
        h.post(&bo, "/api/v1/patterns/generate", &body),
    );
    assert_eq!(a.status, StatusCode::OK, "{:?}", a.body);
    assert_eq!(b.status, StatusCode::OK, "{:?}", b.body);
    assert_eq!(openai.received_requests().await.unwrap().len(), 2);
    assert!(anthropic.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn switching_the_active_provider_sends_the_next_request_to_the_other_vendor() {
    let (anthropic, openai) = (MockServer::start().await, MockServer::start().await);
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(anthropic_ok())
        .mount(&anthropic)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(openai_ok())
        .mount(&openai)
        .await;
    let h = wiremock_harness(&anthropic, &openai).await;
    let cookie = h
        .user_with_key("ana@example.com", AiProvider::Anthropic, ANTHROPIC_KEY)
        .await;
    let user = api::users::find_by_email(h.app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    let ring = h.app.state.config.master_keys.as_ref().unwrap();
    let key = UserApiKey::new(OPENAI_KEY.to_string());
    let sealed = keys::encrypt(ring, &user.id, AiProvider::Openai, &key).unwrap();
    keys::upsert(
        h.app.db(),
        &user.id,
        AiProvider::Openai,
        &sealed,
        &key.last4(),
    )
    .await
    .unwrap();

    let first = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(anthropic.received_requests().await.unwrap().len(), 1);
    assert!(openai.received_requests().await.unwrap().is_empty());

    let switched = h
        .app
        .send(request(
            "PUT",
            "/api/v1/account/ai-provider",
            Some(&cookie),
            Some(json!({"provider": "openai"})),
        ))
        .await;
    assert_eq!(switched.status, StatusCode::OK);

    let second = h
        .post(&cookie, "/api/v1/patterns/generate", &generate_body())
        .await;
    assert_eq!(second.status, StatusCode::OK, "{:?}", second.body);
    assert_eq!(anthropic.received_requests().await.unwrap().len(), 1);
    let sent = openai.received_requests().await.unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0]
            .headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap(),
        format!("Bearer {OPENAI_KEY}")
    );
}
