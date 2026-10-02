use std::time::Duration;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderValue, Method};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::config::Config;
use crate::error::ApiError;
use crate::state::AppState;

/// Generation bodies are a short description plus a few numbers, and export
/// bodies are a pattern document of at most a few thousand notes.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

/// Songs are far larger than patterns: a song at the 16-track, 128-measure caps
/// with a note on every step serializes to just under 2 MiB, so a smaller limit
/// would reject songs the Studio lets users build. The lyrics endpoints reuse
/// this limit rather than choosing their own number.
pub const SONG_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

async fn healthz() -> Json<Value> {
    // Deliberately touches no provider or network so it reflects only this process.
    Json(json!({"status": "ok"}))
}

/// Short so an orchestrator's probe gets an answer before its own timeout fires.
const READINESS_TIMEOUT: Duration = Duration::from_secs(2);

async fn readyz(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let probe = sqlx::query("SELECT 1").execute(state.db.pool());
    match tokio::time::timeout(READINESS_TIMEOUT, probe).await {
        Ok(Ok(_)) => Ok(Json(json!({"status": "ready"}))),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "readiness probe failed");
            Err(ApiError::NotReady)
        }
        Err(_) => {
            tracing::warn!("readiness probe timed out");
            Err(ApiError::NotReady)
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .merge(crate::patterns::router())
        // Applied to the sub-router so it runs inside the global limit and
        // overrides it for these routes only.
        .merge(crate::songs::router().layer(DefaultBodyLimit::max(SONG_MAX_BODY_BYTES)))
}

/// Split from `routes` so tests can exercise the same layers, in the same
/// order, around routes of their own.
pub fn middleware(router: Router, config: &Config) -> Router {
    let origins: Vec<HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);

    router
        .fallback(|| async { ApiError::NotFound })
        .method_not_allowed_fallback(|| async { ApiError::MethodNotAllowed })
        // Enforced by the body extractor rather than a tower layer because the
        // layer answers oversize Content-Length with a plain-text 413, while
        // the extractor's rejection is mapped into the standard JSON error.
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        // Outside the body limit so a 413 still carries CORS headers and the
        // browser shows the real error instead of a CORS failure.
        .layer(cors)
        // INFO because the default log filter is info, and request logs are
        // the only record of who called what.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
}

pub fn app(state: AppState) -> Router {
    let config = state.config.clone();
    middleware(routes().with_state(state), &config)
}
