use axum::extract::State;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use music::generate::generate_pattern;
use music::midi::{pattern_to_midi, MidiError};
use music::{GenerateRequestBody, GenerationLimits, InstrumentInfo, Pattern};

use crate::error::{ApiError, ApiJson};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/patterns/generate", post(generate))
        .route("/api/v1/patterns/limits", get(limits))
        .route("/api/v1/patterns/export/midi", post(export_midi))
        .route("/api/v1/instruments", get(instruments))
}

async fn generate(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<GenerateRequestBody>,
) -> Result<Json<Pattern>, ApiError> {
    // Validation precedes the provider so rejected requests never cost tokens.
    let request = body.validate(&state.instruments, state.config.max_input_tokens)?;
    let outcome = tokio::time::timeout(
        state.config.generation_timeout,
        generate_pattern(state.provider.as_ref(), &request),
    )
    .await;
    match outcome {
        Err(_elapsed) => {
            tracing::warn!(
                timeout_secs = state.config.generation_timeout.as_secs(),
                "generation timed out"
            );
            Err(ApiError::GenerationTimeout)
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "generation failed");
            Err(ApiError::GenerationFailed)
        }
        Ok(Ok(pattern)) => Ok(Json(pattern)),
    }
}

async fn limits(State(state): State<AppState>) -> Json<GenerationLimits> {
    Json(GenerationLimits::new(state.config.max_input_tokens))
}

async fn instruments(State(state): State<AppState>) -> Json<Vec<InstrumentInfo>> {
    Json(state.instruments.infos())
}

async fn export_midi(
    State(state): State<AppState>,
    ApiJson(mut pattern): ApiJson<Pattern>,
) -> Result<Response, ApiError> {
    pattern.fill_default_program(&state.instruments);
    let bytes = pattern_to_midi(&pattern).map_err(|error| match error {
        MidiError::InvalidPattern(message) => ApiError::InvalidPattern(message),
        MidiError::Write(error) => {
            tracing::error!(%error, "MIDI serialization failed");
            ApiError::Internal
        }
    })?;
    let disposition = format!(
        "attachment; filename=\"{}\"",
        export_filename(&pattern.name, pattern.tempo_bpm)
    );
    let disposition = HeaderValue::from_str(&disposition).expect("filename is ASCII");
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("audio/midi")),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    )
        .into_response())
}

/// ASCII-only and quote-free so the name is safe inside a header value
/// whatever the user typed.
pub(crate) fn slugify(name: &str, fallback: &'static str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() { fallback } else { slug }.to_string()
}

pub fn export_filename(name: &str, tempo_bpm: u32) -> String {
    format!("songbird-{}-{tempo_bpm}bpm.mid", slugify(name, "pattern"))
}

#[cfg(test)]
mod tests {
    use super::export_filename;

    #[test]
    fn filename_is_slugged() {
        assert_eq!(
            export_filename("Boom Bap", 90),
            "songbird-boom-bap-90bpm.mid"
        );
        assert_eq!(
            export_filename("  Dusty!! \"Boom\" / Bap  ", 90),
            "songbird-dusty-boom-bap-90bpm.mid"
        );
        assert_eq!(export_filename("🥁", 120), "songbird-pattern-120bpm.mid");
    }
}
