use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use music::{ChatRequestError, SongError, TrackRequestError, ValidationError};
use serde::de::DeserializeOwned;
use serde_json::json;

/// Messages here are user-facing: never put upstream bodies, keys, or other
/// internals in them, because they are returned verbatim.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("The request body is not valid JSON for this endpoint.")]
    InvalidJson,
    #[error("The request body is too large.")]
    PayloadTooLarge,
    #[error("No such endpoint.")]
    NotFound,
    #[error("That method is not allowed on this endpoint.")]
    MethodNotAllowed,
    /// The message names the offending field; it only describes the caller's
    /// own document, so nothing internal leaks.
    #[error("The pattern is not exportable: {0}")]
    InvalidPattern(String),
    /// The message names the offending track; it only describes the caller's
    /// own document, so nothing internal leaks.
    #[error("The song is not exportable: {0}")]
    InvalidSong(String),
    /// Reported under the same code as the pattern endpoints so the client
    /// handles an unknown instrument one way wherever it appears.
    #[error("The song is not exportable: {0}")]
    InvalidSongInstrument(String),
    /// The chat spec rejects every invalid body with 400, unlike the other song
    /// routes whose specs say 422, so its errors keep their codes but carry
    /// their own status.
    #[error("{message}")]
    ChatRejected { code: &'static str, message: String },
    #[error("The song has no track with that id.")]
    InvalidTrack,
    /// 400 rather than 422 because no document change fixes it: the request
    /// asks for something audio tracks can never do.
    #[error("Audio tracks cannot be generated into; choose an instrument track.")]
    AudioTrackTarget,
    #[error("Sampler tracks cannot be generated into; choose an instrument track.")]
    SamplerTrackTarget,
    #[error("The range must lie within the song and span at most 32 measures; a song longer than 32 measures needs a range.")]
    InvalidRange,
    #[error("Something went wrong on our side. Please try again.")]
    Internal,
    #[error("{0}")]
    Validation(#[from] ValidationError),
    /// Deliberately vague: the real cause may quote provider output.
    #[error("The AI provider could not produce a valid pattern. Please try again.")]
    GenerationFailed,
    /// Deliberately vague: database errors can quote the connection URL.
    #[error("The service is not ready to handle requests.")]
    NotReady,
    #[error("Generation took too long and was cancelled. Please try again.")]
    GenerationTimeout,
    #[error("Too many generations are already running. Please try again shortly.")]
    GenerationBusy,
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::InvalidJson
            | Self::ChatRejected { .. }
            | Self::AudioTrackTarget
            | Self::SamplerTrackTarget => StatusCode::BAD_REQUEST,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::InvalidPattern(_)
            | Self::InvalidSong(_)
            | Self::InvalidSongInstrument(_)
            | Self::InvalidTrack
            | Self::InvalidRange
            | Self::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Self::GenerationFailed => StatusCode::BAD_GATEWAY,
            Self::GenerationTimeout => StatusCode::GATEWAY_TIMEOUT,
            Self::GenerationBusy => StatusCode::SERVICE_UNAVAILABLE,
            Self::NotReady => StatusCode::SERVICE_UNAVAILABLE,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::PayloadTooLarge => "payload_too_large",
            Self::NotFound => "not_found",
            Self::MethodNotAllowed => "method_not_allowed",
            Self::InvalidPattern(_) => "invalid_pattern",
            Self::InvalidSong(_) => "invalid_song",
            Self::InvalidSongInstrument(_) => "invalid_instrument",
            Self::ChatRejected { code, .. } => code,
            Self::InvalidTrack => "invalid_track",
            Self::AudioTrackTarget => "audio_track_target",
            Self::SamplerTrackTarget => "invalid_target",
            Self::InvalidRange => "invalid_range",
            Self::Internal => "internal_error",
            Self::Validation(e) => e.code(),
            Self::GenerationFailed => "generation_failed",
            Self::GenerationTimeout => "generation_timeout",
            Self::GenerationBusy => "generation_busy",
            Self::NotReady => "not_ready",
        }
    }
}

impl From<TrackRequestError> for ApiError {
    fn from(error: TrackRequestError) -> Self {
        match error {
            TrackRequestError::Song(SongError::UnknownInstrument { message }) => {
                Self::InvalidSongInstrument(message)
            }
            TrackRequestError::Song(SongError::Invalid { message, .. }) => {
                Self::InvalidSong(message)
            }
            TrackRequestError::InvalidTrack => Self::InvalidTrack,
            TrackRequestError::AudioTrack => Self::AudioTrackTarget,
            TrackRequestError::SamplerTrack => Self::SamplerTrackTarget,
            TrackRequestError::Prompt(e) => Self::Validation(e),
            TrackRequestError::InvalidRange => Self::InvalidRange,
        }
    }
}

impl From<ChatRequestError> for ApiError {
    fn from(error: ChatRequestError) -> Self {
        // Reuses the codes of the other routes so a client maps them one way.
        let code = match &error {
            ChatRequestError::Song(SongError::UnknownInstrument { .. }) => "invalid_instrument",
            other => other.code(),
        };
        Self::ChatRejected {
            code,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({"error": {"code": self.code(), "message": self.to_string()}});
        (self.status(), Json(body)).into_response()
    }
}

impl From<JsonRejection> for ApiError {
    fn from(rejection: JsonRejection) -> Self {
        // Kept separate from other rejections so an oversize body is reported
        // as such rather than as malformed JSON.
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Self::PayloadTooLarge
        } else {
            Self::InvalidJson
        }
    }
}

/// Wraps `axum::Json` so body rejections use the standard error shape instead
/// of axum's plain-text default.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(ApiError::from)
    }
}
