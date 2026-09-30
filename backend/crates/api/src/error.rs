use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use music::ValidationError;
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
    #[error("Something went wrong on our side. Please try again.")]
    Internal,
    #[error("{0}")]
    Validation(#[from] ValidationError),
    /// Deliberately vague: the real cause may quote provider output.
    #[error("The AI provider could not produce a valid pattern. Please try again.")]
    GenerationFailed,
    #[error("Generation took too long and was cancelled. Please try again.")]
    GenerationTimeout,
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::InvalidJson => StatusCode::BAD_REQUEST,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::InvalidPattern(_) | Self::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Self::GenerationFailed => StatusCode::BAD_GATEWAY,
            Self::GenerationTimeout => StatusCode::GATEWAY_TIMEOUT,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::PayloadTooLarge => "payload_too_large",
            Self::NotFound => "not_found",
            Self::MethodNotAllowed => "method_not_allowed",
            Self::InvalidPattern(_) => "invalid_pattern",
            Self::Internal => "internal_error",
            Self::Validation(e) => e.code(),
            Self::GenerationFailed => "generation_failed",
            Self::GenerationTimeout => "generation_timeout",
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
