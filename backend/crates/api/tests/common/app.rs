//! A full app over a test database, with a provider that counts its calls so
//! tests can assert that a refused request never reached it.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use api::auth::password::PasswordService;
use api::config::{Config, AI_PROVIDER, ENV};
use api::provider::Providers;
use api::state::AppState;
use argon2::Params;
use async_trait::async_trait;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use music::ai::plan::{PlanDraft, PlanRequest};
use music::ai::{MockPlanProvider, MockProvider, PatternProvider, PlanProvider, ProviderError};
use music::{GenerateRequest, Instrument, InstrumentRegistry, PatternDraft};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::db::{test_db, TestDb};

pub const ALLOWED_ORIGIN: &str = "http://localhost:3000";
pub const PEER: &str = "203.0.113.5:4000";

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

struct CountingPlans(Arc<AtomicUsize>);

#[async_trait]
impl PlanProvider for CountingPlans {
    async fn plan(&self, request: &PlanRequest) -> Result<PlanDraft, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        MockPlanProvider.plan(request).await
    }
    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

pub struct Response {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
}

pub struct TestApp {
    pub router: Router,
    pub state: AppState,
    pub provider_calls: Arc<AtomicUsize>,
    db: Arc<TestDb>,
}

/// Cheap parameters keep debug-build tests fast; the hashing rules are the same.
pub fn fast_passwords(permits: usize) -> PasswordService {
    PasswordService::with_params(Params::new(8, 1, 1, None).unwrap(), permits)
}

fn config(extra: &[(&str, &str)]) -> Config {
    Config::from_lookup(|k| {
        if k == ENV {
            return Some("development".into());
        }
        if k == AI_PROVIDER {
            return Some("mock".into());
        }
        extra
            .iter()
            .find(|(name, _)| *name == k)
            .map(|(_, v)| v.to_string())
    })
    .expect("test config")
}

impl TestApp {
    pub async fn new(extra: &[(&str, &str)]) -> Self {
        Self::with_state(extra, |_| {}).await
    }

    pub async fn with_state(extra: &[(&str, &str)], tweak: impl FnOnce(&mut AppState)) -> Self {
        let db = Arc::new(test_db().await);
        Self::over(db, extra, tweak)
    }

    /// A second app on the same database, as a restart would build.
    pub fn rebuild(&self, extra: &[(&str, &str)]) -> Self {
        Self::over(self.db.clone(), extra, |_| {})
    }

    fn over(db: Arc<TestDb>, extra: &[(&str, &str)], tweak: impl FnOnce(&mut AppState)) -> Self {
        let provider_calls = Arc::new(AtomicUsize::new(0));
        let providers = Providers::new(
            CountingPatterns(provider_calls.clone()),
            CountingPlans(provider_calls.clone()),
        );
        let mut state = AppState::new(
            providers,
            InstrumentRegistry::builtin(),
            Arc::new(config(extra)),
            (**db).clone(),
        );
        state.passwords = fast_passwords(2);
        tweak(&mut state);
        let router = api::app(state.clone())
            .layer(MockConnectInfo(PEER.parse::<SocketAddr>().expect("peer")));
        Self {
            router,
            state,
            provider_calls,
            db,
        }
    }

    pub fn db(&self) -> &api::db::Db {
        &self.db
    }

    pub fn calls(&self) -> usize {
        self.provider_calls.load(Ordering::SeqCst)
    }

    pub async fn send(&self, request: Request<Body>) -> Response {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        Response {
            status: parts.status,
            headers: parts.headers,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    pub async fn create_user(&self, email: &str, password: &str) -> api::users::User {
        let hash = self
            .state
            .passwords
            .hash(&secrecy::SecretString::from(password.to_string()))
            .await
            .expect("hash");
        api::users::create(self.db(), email, &hash)
            .await
            .expect("create user")
    }

    /// A signed-in user without a login round trip.
    pub async fn cookie_for(&self, email: &str) -> String {
        super::session::login_as(self.db(), email).await
    }
}

pub fn request(
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

pub fn login_request(email: &str, password: &str) -> Request<Body> {
    request(
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({"email": email, "password": password})),
    )
}

pub fn login_request_with(email: &str, password: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder =
        Request::post("/api/v1/auth/login").header(header::CONTENT_TYPE, "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder
        .body(Body::from(
            json!({"email": email, "password": password}).to_string(),
        ))
        .unwrap()
}

/// The `name=value` pair of the cookie a login response set.
pub fn cookie_pair(response: &Response) -> String {
    response.headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

/// A valid song with the given number of tracks, for project tests.
pub fn song(name: &str, track_count: usize) -> Value {
    let tracks: Vec<Value> = (0..track_count)
        .map(|i| {
            json!({
                "id": format!("t{i}"), "name": format!("Track {i}"), "instrument": "drums",
                "volume_db": 0, "pan": 0, "muted": false, "soloed": false,
                "loops": [{"id": format!("l{i}"), "name": "Beat", "measures": 1,
                    "notes": [{"row_id": "kick", "step": 0, "length_steps": 1, "velocity": 100}]}],
                "clips": [{"id": format!("c{i}"), "loop_id": format!("l{i}"), "start_measure": 1, "measures": 4}],
            })
        })
        .collect();
    json!({
        "version": 2, "id": "client-chosen-id", "name": name, "tempo_bpm": 96,
        "time_signature": "4/4", "steps_per_measure": 16, "swing": 0,
        "measures": 4, "tracks": tracks,
    })
}
