use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use music::{ChatRequestError, LyricsRequestError, SongError, TrackRequestError, ValidationError};
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
    /// 422 like the other song routes, not the chat's 400, so the client's
    /// existing handling of a 422 shows the server's message with no mapping.
    #[error("{message}")]
    LyricsRejected { code: &'static str, message: String },
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
    #[error("Sign in to continue.")]
    Unauthenticated,
    /// One message for an unknown email, a wrong password and a disabled
    /// account, so the response cannot reveal which accounts exist.
    #[error("Email or password is incorrect.")]
    InvalidCredentials,
    #[error("This request came from an origin that is not allowed.")]
    Forbidden,
    /// Used for a missing project and for someone else's alike, so the two
    /// cannot be told apart.
    #[error("No such project.")]
    ProjectNotFound,
    #[error("The project was changed elsewhere. Reload it before saving.")]
    RevisionConflict,
    #[error("You have reached the limit on projects or stored song data.")]
    ProjectLimit,
    #[error("The song's id does not match the project being saved.")]
    IdMismatch,
    #[error("Too many requests. Please try again shortly.")]
    TooManyRequests { retry_after: u64 },
    #[error("The server is busy. Please try again shortly.")]
    ServerBusy { retry_after: u64 },
    #[error("Too many generations are already running. Please try again shortly.")]
    GenerationBusy,
    #[error("Add an Anthropic or OpenAI API key in Settings \u{2192} AI keys to use AI features.")]
    ApiKeyRequired,
    /// The provider name is a fixed string chosen by the server, never provider output.
    #[error("Your {provider} key was rejected. Replace it in Settings \u{2192} AI keys.")]
    ApiKeyInvalid { provider: &'static str },
    /// Same response as `ApiKeyInvalid`, but raised before any provider was contacted, which
    /// is what makes it safe to refund from the daily quota.
    #[error("Your {provider} key was rejected. Replace it in Settings \u{2192} AI keys.")]
    StoredKeyUnusable { provider: &'static str },
    #[error("Your {provider} account has no credit or quota left. Check billing with {provider}.")]
    ApiKeyQuotaExhausted { provider: &'static str },
    #[error("Your {provider} key is being rate limited. Try again shortly.")]
    ApiKeyRateLimited {
        provider: &'static str,
        retry_after: Option<u64>,
    },
    #[error("That does not look like a valid API key for this provider.")]
    InvalidApiKeyFormat,
    #[error("{provider} rejected that key. Check that it is correct and has not been revoked.")]
    ApiKeyRejected { provider: &'static str },
    #[error("Could not reach {provider} to check the key. Please try again shortly.")]
    ProviderUnreachable { provider: &'static str },
    #[error("Saving AI keys is not available on this server.")]
    ApiKeysUnavailable,
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
            | Self::LyricsRejected { .. }
            | Self::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Self::GenerationFailed => StatusCode::BAD_GATEWAY,
            Self::GenerationTimeout => StatusCode::GATEWAY_TIMEOUT,
            Self::GenerationBusy => StatusCode::SERVICE_UNAVAILABLE,
            Self::NotReady => StatusCode::SERVICE_UNAVAILABLE,
            Self::Unauthenticated | Self::InvalidCredentials => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::ProjectNotFound => StatusCode::NOT_FOUND,
            Self::RevisionConflict
            | Self::ProjectLimit
            | Self::ApiKeyRequired
            | Self::ApiKeyInvalid { .. }
            | Self::StoredKeyUnusable { .. }
            | Self::ApiKeyQuotaExhausted { .. } => StatusCode::CONFLICT,
            Self::ApiKeyRateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::InvalidApiKeyFormat | Self::ApiKeyRejected { .. } => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            Self::ProviderUnreachable { .. } => StatusCode::BAD_GATEWAY,
            Self::ApiKeysUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::IdMismatch => StatusCode::UNPROCESSABLE_ENTITY,
            Self::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::ServerBusy { .. } => StatusCode::SERVICE_UNAVAILABLE,
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
            Self::ChatRejected { code, .. } | Self::LyricsRejected { code, .. } => code,
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
            Self::Unauthenticated => "unauthenticated",
            Self::InvalidCredentials => "invalid_credentials",
            Self::Forbidden => "forbidden",
            Self::ProjectNotFound => "not_found",
            Self::RevisionConflict => "revision_conflict",
            Self::ProjectLimit => "project_limit",
            Self::IdMismatch => "id_mismatch",
            Self::TooManyRequests { .. } => "too_many_requests",
            Self::ServerBusy { .. } => "server_busy",
            Self::ApiKeyRequired => "api_key_required",
            Self::ApiKeyInvalid { .. } | Self::StoredKeyUnusable { .. } => "api_key_invalid",
            Self::ApiKeyQuotaExhausted { .. } => "api_key_quota_exhausted",
            Self::ApiKeyRateLimited { .. } => "api_key_rate_limited",
            Self::InvalidApiKeyFormat => "invalid_api_key_format",
            Self::ApiKeyRejected { .. } => "api_key_rejected",
            Self::ProviderUnreachable { .. } => "provider_unreachable",
            Self::ApiKeysUnavailable => "api_keys_unavailable",
        }
    }

    fn retry_after(&self) -> Option<u64> {
        match self {
            Self::TooManyRequests { retry_after } | Self::ServerBusy { retry_after } => {
                Some(*retry_after)
            }
            Self::ApiKeyRateLimited { retry_after, .. } => *retry_after,
            _ => None,
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

impl From<LyricsRequestError> for ApiError {
    fn from(error: LyricsRequestError) -> Self {
        match error {
            // The latest message goes through the shared prompt rules, so it
            // surfaces exactly as it does on the other routes.
            LyricsRequestError::Prompt(e) => Self::Validation(e),
            other => Self::LyricsRejected {
                code: other.code(),
                message: other.to_string(),
            },
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

/// Set on responses for failures that happened before any provider was contacted, so the
/// metering layer can give the request back without parsing the body. A provider's own
/// rejection is deliberately not marked: a revoked key must not get free attempts that each
/// reach the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NeverReachedProvider;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({"error": {"code": self.code(), "message": self.to_string()}});
        let mut response = (self.status(), Json(body)).into_response();
        if matches!(self, Self::ApiKeyRequired | Self::StoredKeyUnusable { .. }) {
            response.extensions_mut().insert(NeverReachedProvider);
        }
        if let Some(seconds) = self.retry_after() {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
        }
        response
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_variants_have_the_documented_status_and_code() {
        for (error, status, code) in [
            (ApiError::Unauthenticated, 401, "unauthenticated"),
            (ApiError::InvalidCredentials, 401, "invalid_credentials"),
            (ApiError::Forbidden, 403, "forbidden"),
            (ApiError::ProjectNotFound, 404, "not_found"),
            (ApiError::RevisionConflict, 409, "revision_conflict"),
            (ApiError::ProjectLimit, 409, "project_limit"),
            (ApiError::IdMismatch, 422, "id_mismatch"),
            (
                ApiError::TooManyRequests { retry_after: 3 },
                429,
                "too_many_requests",
            ),
            (ApiError::ServerBusy { retry_after: 1 }, 503, "server_busy"),
            (
                ApiError::LyricsRejected {
                    code: "invalid_selection",
                    message: "bad".into(),
                },
                422,
                "invalid_selection",
            ),
        ] {
            assert_eq!(error.status().as_u16(), status, "{code}");
            assert_eq!(error.code(), code);
        }
    }

    #[test]
    fn api_key_errors_have_the_documented_status_code_and_provider_named_message() {
        let p = "Anthropic";
        for (error, status, code) in [
            (ApiError::ApiKeyRequired, 409, "api_key_required"),
            (
                ApiError::ApiKeyInvalid { provider: p },
                409,
                "api_key_invalid",
            ),
            (
                ApiError::ApiKeyQuotaExhausted { provider: p },
                409,
                "api_key_quota_exhausted",
            ),
            (
                ApiError::ApiKeyRateLimited {
                    provider: p,
                    retry_after: Some(20),
                },
                429,
                "api_key_rate_limited",
            ),
            (ApiError::InvalidApiKeyFormat, 422, "invalid_api_key_format"),
            (
                ApiError::ApiKeyRejected { provider: p },
                422,
                "api_key_rejected",
            ),
            (
                ApiError::ProviderUnreachable { provider: p },
                502,
                "provider_unreachable",
            ),
            (ApiError::ApiKeysUnavailable, 503, "api_keys_unavailable"),
        ] {
            assert_eq!(error.status().as_u16(), status, "{code}");
            assert_eq!(error.code(), code);
        }
        for error in [
            ApiError::ApiKeyInvalid { provider: p },
            ApiError::ApiKeyQuotaExhausted { provider: p },
            ApiError::ApiKeyRateLimited {
                provider: p,
                retry_after: None,
            },
        ] {
            assert!(error.to_string().contains(p), "{error}");
        }
    }

    #[test]
    fn only_failures_before_any_provider_call_are_marked_refundable() {
        let marked = |error: ApiError| {
            error
                .into_response()
                .extensions()
                .get::<NeverReachedProvider>()
                .is_some()
        };
        assert!(marked(ApiError::ApiKeyRequired));
        assert!(marked(ApiError::StoredKeyUnusable {
            provider: "Anthropic"
        }));
        assert!(!marked(ApiError::ApiKeyInvalid {
            provider: "Anthropic"
        }));
        assert!(!marked(ApiError::ApiKeyQuotaExhausted {
            provider: "Anthropic"
        }));
        assert!(!marked(ApiError::GenerationFailed));
        let unusable = ApiError::StoredKeyUnusable { provider: "OpenAI" };
        let invalid = ApiError::ApiKeyInvalid { provider: "OpenAI" };
        assert_eq!(unusable.code(), invalid.code());
        assert_eq!(unusable.status(), invalid.status());
        assert_eq!(unusable.to_string(), invalid.to_string());
    }

    #[test]
    fn a_provider_retry_after_is_passed_through_when_present() {
        let with = ApiError::ApiKeyRateLimited {
            provider: "OpenAI",
            retry_after: Some(20),
        }
        .into_response();
        assert_eq!(with.headers()[header::RETRY_AFTER], "20");
        let without = ApiError::ApiKeyRateLimited {
            provider: "OpenAI",
            retry_after: None,
        }
        .into_response();
        assert!(without.headers().get(header::RETRY_AFTER).is_none());
    }

    #[test]
    fn retry_after_is_sent_in_seconds_on_429_and_503_only() {
        let limited = ApiError::TooManyRequests { retry_after: 42 }.into_response();
        assert_eq!(limited.headers()[header::RETRY_AFTER], "42");
        let busy = ApiError::ServerBusy { retry_after: 1 }.into_response();
        assert_eq!(busy.headers()[header::RETRY_AFTER], "1");
        let other = ApiError::Unauthenticated.into_response();
        assert!(other.headers().get(header::RETRY_AFTER).is_none());
    }

    #[tokio::test]
    async fn error_body_keeps_the_standard_shape() {
        use http_body_util::BodyExt;
        let response = ApiError::Forbidden.into_response();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "forbidden");
        assert!(body["error"]["message"].is_string());
    }
}
