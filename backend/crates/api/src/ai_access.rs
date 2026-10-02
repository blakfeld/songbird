//! Decides, per request, which provider credentials an AI call may use. Development with an
//! operator provider shares one bundle; per-user mode builds a bundle around the caller's own
//! key so an operator credential can never serve a user's request.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use music::ai::{
    claude, openai, ClaudeProvider, HttpClient, KeyCheckError, LyricsProvider, MockProvider,
    OpenAiProvider, PatternProvider, PlanProvider, ProviderError, StreamingMockPlanProvider,
    StructuredProvider,
};
use music::generate::GenerationError;
use music::{Instrument, PatternDraft};
use secrecy::SecretString;

use crate::auth::http::CurrentUser;
use crate::config::Config;
use crate::error::ApiError;
use crate::keys::{self, AiProvider, UserApiKey};
use crate::provider::{client_timeout, Providers};
use crate::state::AppState;

/// Long enough for a slow provider to answer a models-list call, short enough that a save
/// request does not hang on an unreachable one.
const KEY_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub enum AiAccess {
    Shared(Providers),
    PerUser(Arc<dyn UserProviders>),
}

/// Prints only which mode is active: the bundles hold transports, and a derived `Debug` would
/// become a path for key-bearing fields to reach a log if one is ever added.
impl std::fmt::Debug for AiAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Shared(_) => "AiAccess::Shared",
            Self::PerUser(_) => "AiAccess::PerUser",
        })
    }
}

#[async_trait]
pub trait UserProviders: Send + Sync {
    fn providers(&self, provider: AiProvider, key: UserApiKey) -> Providers;

    async fn check_key(&self, provider: AiProvider, key: &UserApiKey) -> Result<(), KeyCheckError>;
}

fn secret(key: &UserApiKey) -> SecretString {
    SecretString::from(key.expose_secret().to_string())
}

/// One client for every user because connection pools are per client, and a client per
/// request would repeat the TLS handshake on every call.
pub struct RealUserProviders {
    client: HttpClient,
    anthropic_url: String,
    openai_url: String,
    anthropic_model: String,
    openai_model: String,
}

impl RealUserProviders {
    pub fn new(config: &Config) -> Self {
        Self {
            client: music::ai::http_client(client_timeout(config)),
            anthropic_url: claude::DEFAULT_BASE_URL.into(),
            openai_url: openai::DEFAULT_BASE_URL.into(),
            anthropic_model: config.ai_model.clone(),
            openai_model: config.openai_model.clone(),
        }
    }

    /// Lets tests point both vendors at local fakes.
    pub fn with_base_urls(
        mut self,
        anthropic: impl Into<String>,
        openai: impl Into<String>,
    ) -> Self {
        self.anthropic_url = anthropic.into().trim_end_matches('/').to_string();
        self.openai_url = openai.into().trim_end_matches('/').to_string();
        self
    }
}

impl std::fmt::Debug for RealUserProviders {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RealUserProviders")
            .field("anthropic_url", &self.anthropic_url)
            .field("openai_url", &self.openai_url)
            .field("anthropic_model", &self.anthropic_model)
            .field("openai_model", &self.openai_model)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl UserProviders for RealUserProviders {
    fn providers(&self, provider: AiProvider, key: UserApiKey) -> Providers {
        let transport: Arc<dyn StructuredProvider> = match provider {
            AiProvider::Anthropic => Arc::new(
                ClaudeProvider::new(secret(&key), self.anthropic_model.clone())
                    .with_base_url(self.anthropic_url.clone())
                    .with_client(self.client.clone()),
            ),
            AiProvider::Openai => Arc::new(
                OpenAiProvider::new(secret(&key), self.openai_model.clone())
                    .with_base_url(self.openai_url.clone())
                    .with_client(self.client.clone()),
            ),
        };
        Providers::over(transport)
    }

    async fn check_key(&self, provider: AiProvider, key: &UserApiKey) -> Result<(), KeyCheckError> {
        match provider {
            AiProvider::Anthropic => {
                claude::check_key(
                    &self.client,
                    &self.anthropic_url,
                    &secret(key),
                    KEY_CHECK_TIMEOUT,
                )
                .await
            }
            AiProvider::Openai => {
                openai::check_key(
                    &self.client,
                    &self.openai_url,
                    &secret(key),
                    KEY_CHECK_TIMEOUT,
                )
                .await
            }
        }
    }
}

/// Runs everything but the network, so e2e and tests exercise the real storage, extractor and
/// error mapping with outcomes chosen by the key's ending.
#[derive(Debug)]
pub struct MockUserProviders;

const MOCK_RETRY_AFTER_SECS: u64 = 5;

impl MockUserProviders {
    fn failure(key: &UserApiKey) -> Option<ProviderError> {
        let key = key.expose_secret();
        if key.ends_with("-revoked") {
            Some(ProviderError::Unauthorized)
        } else if key.ends_with("-quota") {
            Some(ProviderError::QuotaExhausted)
        } else if key.ends_with("-ratelimited") {
            Some(ProviderError::RateLimited {
                retry_after: Some(MOCK_RETRY_AFTER_SECS),
            })
        } else {
            None
        }
    }
}

#[async_trait]
impl UserProviders for MockUserProviders {
    fn providers(&self, _: AiProvider, key: UserApiKey) -> Providers {
        match Self::failure(&key) {
            None => Providers::new(SlowMockPatterns, StreamingMockPlanProvider::default()),
            Some(error) => Providers::new(Failing(error.clone()), Failing(error.clone()))
                .with_lyrics(Failing(error)),
        }
    }

    async fn check_key(&self, _: AiProvider, key: &UserApiKey) -> Result<(), KeyCheckError> {
        let key = key.expose_secret();
        if key.ends_with("-rejected") {
            Err(KeyCheckError::Rejected)
        } else if key.ends_with("-unreachable") {
            Err(KeyCheckError::Unreachable)
        } else {
            Ok(())
        }
    }
}

/// Browser tests assert on the "Writing ..." step, which the instant mock would replace with
/// the track before it could render; only `user-mock` pays this delay, so unit and API tests
/// on the plain mock stay fast.
struct SlowMockPatterns;

const MOCK_GENERATION_DELAY: Duration = Duration::from_millis(300);

#[async_trait]
impl PatternProvider for SlowMockPatterns {
    async fn generate(
        &self,
        request: &music::GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        tokio::time::sleep(MOCK_GENERATION_DELAY).await;
        MockProvider.generate(request, instrument).await
    }

    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Failing(ProviderError);

#[async_trait]
impl PatternProvider for Failing {
    async fn generate(
        &self,
        _: &music::GenerateRequest,
        _: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        Err(self.0.clone())
    }

    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[async_trait]
impl PlanProvider for Failing {
    async fn plan(
        &self,
        _: &music::ai::plan::PlanRequest,
    ) -> Result<music::ai::plan::PlanDraft, ProviderError> {
        Err(self.0.clone())
    }

    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[async_trait]
impl LyricsProvider for Failing {
    async fn assist(
        &self,
        _: &music::ai::LyricsRequest,
    ) -> Result<music::lyrics::LyricsDraft, ProviderError> {
        Err(self.0.clone())
    }

    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

/// Handlers take this before their body, so a user without a key gets the actionable
/// `api_key_required` instead of a validation error.
pub struct RequestProviders {
    pub providers: Providers,
    /// For error messages that tell the user which account to look at.
    pub provider_name: &'static str,
}

impl FromRequestParts<AppState> for RequestProviders {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        let factory = match &state.ai {
            AiAccess::Shared(providers) => {
                return Ok(Self {
                    providers: providers.clone(),
                    provider_name: state.config.ai_provider.display_name(),
                });
            }
            AiAccess::PerUser(factory) => factory,
        };

        let stored = keys::active_key(&state.db, &user.id)
            .await
            .map_err(|error| {
                tracing::error!(%error, "could not load the user's AI key");
                ApiError::Internal
            })?
            .ok_or(ApiError::ApiKeyRequired)?;
        let provider_name = stored.provider.display_name();
        let keyring = state.config.master_keys.as_ref().ok_or_else(|| {
            tracing::error!("per-user keys are enabled without a master keyring");
            ApiError::Internal
        })?;
        let key =
            keys::decrypt(keyring, &user.id, stored.provider, &stored.encrypted).map_err(|_| {
                // Ids and versions only: nothing here may help identify or reconstruct a key.
                tracing::warn!(
                    user_id = %user.id,
                    provider = stored.provider.as_str(),
                    key_version = %stored.encrypted.key_version,
                    "a stored AI key could not be decrypted"
                );
                ApiError::StoredKeyUnusable {
                    provider: provider_name,
                }
            })?;

        tracing::Span::current().record("ai_provider", stored.provider.as_str());
        Ok(Self {
            providers: factory.providers(stored.provider, key),
            provider_name,
        })
    }
}

/// Key problems are told apart from other provider failures so the user is sent to the
/// setting they can change; everything else stays the deliberately vague generation error.
pub fn api_error_for(error: &GenerationError, provider: &'static str) -> ApiError {
    match error {
        GenerationError::Provider(ProviderError::Unauthorized) => {
            ApiError::ApiKeyInvalid { provider }
        }
        GenerationError::Provider(ProviderError::QuotaExhausted) => {
            ApiError::ApiKeyQuotaExhausted { provider }
        }
        GenerationError::Provider(ProviderError::RateLimited { retry_after }) => {
            ApiError::ApiKeyRateLimited {
                provider,
                retry_after: *retry_after,
            }
        }
        _ => ApiError::GenerationFailed,
    }
}
