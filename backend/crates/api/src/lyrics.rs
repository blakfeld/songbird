use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};

use music::lyrics::assist_lyrics;
use music::{LyricsAssistBody, LyricsAssistResponse};

use crate::ai_access::RequestProviders;
use crate::error::{ApiError, ApiJson};
use crate::patterns::with_timeout;
use crate::state::AppState;

/// Every route that calls a provider belongs here so the metering layer covers it.
pub fn ai_router() -> Router<AppState> {
    Router::new().route("/api/v1/lyrics/assist", post(assist))
}

async fn assist(
    State(state): State<AppState>,
    ai: RequestProviders,
    ApiJson(body): ApiJson<LyricsAssistBody>,
) -> Result<Json<LyricsAssistResponse>, ApiError> {
    // Validation precedes the provider so rejected requests never cost tokens.
    let request = body.validate(
        state.config.max_input_tokens,
        state.config.max_context_tokens,
    )?;
    let response = with_timeout(
        state.config.generation_timeout,
        ai.provider_name,
        assist_lyrics(ai.providers.lyrics.as_ref(), &request),
    )
    .await?;
    Ok(Json(response))
}
