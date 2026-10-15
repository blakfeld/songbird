//! Public read routes reached with a share token. Nothing here builds a
//! `CurrentUser` or reads a cookie, so no handler can touch owner state by
//! accident, and nothing logs a token. Routes that act for a signed-in user live in
//! `listen_actions`, behind the session layer.

use std::net::SocketAddr;

use axum::extract::connect_info::ConnectInfo;
use axum::extract::rejection::ExtensionRejection;
use axum::extract::{Path, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use music::{InstrumentInfo, Song, SongError};
use serde_json::{json, Value};

use crate::auth::http::client_address;
use crate::auth::throttle::client_key;
use crate::clock::now_ms;
use crate::error::ApiError;
use crate::share_store::{self as store, ActiveShare, ShareError};
use crate::songs::midi_response;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/listen/{token}", get(show))
        .route("/api/v1/listen/{token}/midi", get(midi))
}

/// Runs before the body is read or the token looked up, so a flood costs no database work.
/// Shared with the session-bound listen actions so a remix or comment from one address counts
/// toward the same budget as its reads.
pub async fn throttle(
    State(state): State<AppState>,
    peer: Result<ConnectInfo<SocketAddr>, ExtensionRejection>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let address = client_key(client_address(
        state.config.client_address_source,
        request.headers(),
        peer.ok().map(|ConnectInfo(addr)| addr),
    ));
    state
        .share_throttle
        .check_read(&address)
        .map_err(|throttled| ApiError::TooManyRequests {
            retry_after: throttled.retry_after_secs,
        })?;
    Ok(next.run(request).await)
}

/// Unknown, malformed, revoked, and expired tokens all end here with one
/// answer, so a response never reveals that a link once existed.
pub(crate) async fn active_share(state: &AppState, token: &str) -> Result<ActiveShare, ApiError> {
    store::find_active(&state.db, token, now_ms())
        .await
        .map_err(|error| match error {
            ShareError::Database(error) => {
                tracing::error!(%error, "share lookup failed");
                ApiError::Internal
            }
            other => {
                tracing::error!(error = %other, "a shared song could not be served");
                ApiError::Internal
            }
        })?
        .ok_or(ApiError::NotFound)
}

pub(crate) fn served_song(share: &ActiveShare) -> Result<Song, ApiError> {
    store::parse_projected(&share.song).map_err(|error| {
        tracing::error!(
            kind = store::json_error_kind(&error),
            "a shared song is not a valid song"
        );
        ApiError::Internal
    })
}

fn instruments_used(state: &AppState, song: &Song) -> Vec<InstrumentInfo> {
    let mut seen: Vec<&str> = Vec::new();
    let mut infos = Vec::new();
    for track in &song.tracks {
        if seen.contains(&track.instrument.as_str()) {
            continue;
        }
        seen.push(&track.instrument);
        if let Some(instrument) = state.instruments.get(&track.instrument) {
            infos.push(instrument.info());
        }
    }
    infos
}

async fn show(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let share = active_share(&state, &token).await?;
    let song = served_song(&share)?;
    Ok(Json(json!({
        "share": {
            "mode": share.mode.as_str(),
            "allow_comments": share.allow_comments,
            "allow_downloads": share.allow_downloads,
            "allow_remix": share.allow_remix,
            "expires_at": share.expires_at,
        },
        "song": share.song,
        "instruments": instruments_used(&state, &song),
        "shared_at": share.shared_at,
    })))
}

async fn midi(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, ApiError> {
    let share = active_share(&state, &token).await?;
    if !share.allow_downloads {
        return Err(ApiError::NotFound);
    }
    let song = served_song(&share)?;
    let valid = song.validate(&state.instruments).map_err(|error| {
        // The error text can quote the owner's song, so only its kind is logged.
        let kind = match error {
            SongError::UnknownInstrument { .. } => "unknown_instrument",
            SongError::Invalid { .. } => "invalid",
        };
        tracing::error!(kind, "a shared song no longer validates");
        ApiError::Internal
    })?;
    midi_response(&valid)
}
