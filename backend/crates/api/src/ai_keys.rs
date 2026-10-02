//! Key management for the signed-in user. Responses carry only the last four characters of a
//! key, and the save body is parsed by hand so that no parser error can quote a submitted key.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use music::ai::KeyCheckError;
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;

use crate::ai_access::{AiAccess, UserProviders};
use crate::auth::http::CurrentUser;
use crate::config::Keyring;
use crate::error::{ApiError, ApiJson};
use crate::keys::{self, AiKeySummary, AiProvider, KeyStoreError, SetProviderBody, UserApiKey};
use crate::state::AppState;

/// Saving checks the key with the provider, so an unthrottled endpoint would let a stolen
/// session test a list of leaked keys.
const SAVES_PER_HOUR: u32 = 10;
const MIN_KEY_CHARS: usize = 20;
const MAX_KEY_CHARS: usize = 256;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/account/ai-keys", get(summary))
        .route(
            "/api/v1/account/ai-keys/{provider}",
            put(save_key).delete(remove_key),
        )
        .route("/api/v1/account/ai-provider", put(set_provider))
}

/// `deny_unknown_fields` so a body that sneaks the key under another name is refused rather
/// than silently ignored.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveKey {
    key: SecretString,
}

struct Manager<'a> {
    keyring: &'a Keyring,
    checker: Arc<dyn UserProviders>,
}

/// Development with an operator provider and no keyring has nowhere safe to put a key.
fn manager(state: &AppState) -> Result<Manager<'_>, ApiError> {
    let keyring = state
        .config
        .master_keys
        .as_ref()
        .ok_or(ApiError::ApiKeysUnavailable)?;
    let checker = match &state.ai {
        AiAccess::PerUser(factory) => factory.clone(),
        AiAccess::Shared(_) => state.shared_key_checker.clone(),
    };
    Ok(Manager { keyring, checker })
}

fn parse_provider(raw: &str) -> Result<AiProvider, ApiError> {
    raw.parse().map_err(|()| ApiError::NotFound)
}

fn internal(error: KeyStoreError) -> ApiError {
    tracing::error!(%error, "AI key storage failed");
    ApiError::Internal
}

async fn summary_for(state: &AppState, user_id: &str) -> Result<Json<AiKeySummary>, ApiError> {
    let stored = keys::summary(&state.db, user_id).await.map_err(internal)?;
    let keys_required = matches!(state.ai, AiAccess::PerUser(_));
    Ok(Json(AiKeySummary::new(keys_required, stored)))
}

async fn summary(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<AiKeySummary>, ApiError> {
    manager(&state)?;
    summary_for(&state, &user.id).await
}

fn well_formed(provider: AiProvider, key: &str) -> bool {
    let prefix_ok = match provider {
        AiProvider::Anthropic => key.starts_with("sk-ant-"),
        AiProvider::Openai => key.starts_with("sk-") && !key.starts_with("sk-ant-"),
    };
    (MIN_KEY_CHARS..=MAX_KEY_CHARS).contains(&key.len())
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && prefix_ok
}

async fn save_key(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(provider): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<AiKeySummary>, ApiError> {
    let manager = manager(&state)?;
    let provider = parse_provider(&provider)?;

    state
        .key_save_limiter
        .try_record(&user.id, SAVES_PER_HOUR)
        .map_err(|retry_after| ApiError::TooManyRequests { retry_after })?;

    let body = body.map_err(|_| ApiError::InvalidJson)?;
    // The parse error is dropped on purpose: serde's text can quote the offending value.
    let SaveKey { key } = serde_json::from_slice(&body).map_err(|_| ApiError::InvalidJson)?;
    let key = UserApiKey::new(SecretString::from(key.expose_secret().trim().to_string()));
    if !well_formed(provider, key.expose_secret()) {
        return Err(ApiError::InvalidApiKeyFormat);
    }

    let name = provider.display_name();
    manager
        .checker
        .check_key(provider, &key)
        .await
        .map_err(|error| match error {
            KeyCheckError::Rejected => ApiError::ApiKeyRejected { provider: name },
            KeyCheckError::Unreachable => ApiError::ProviderUnreachable { provider: name },
        })?;

    let sealed = keys::encrypt(manager.keyring, &user.id, provider, &key).map_err(|error| {
        tracing::error!(%error, "could not encrypt an AI key");
        ApiError::Internal
    })?;
    keys::upsert(&state.db, &user.id, provider, &sealed, &key.last4())
        .await
        .map_err(internal)?;
    summary_for(&state, &user.id).await
}

async fn remove_key(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(provider): Path<String>,
) -> Result<Json<AiKeySummary>, ApiError> {
    manager(&state)?;
    let provider = parse_provider(&provider)?;
    keys::delete(&state.db, &user.id, provider)
        .await
        .map_err(internal)?;
    summary_for(&state, &user.id).await
}

async fn set_provider(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<SetProviderBody>,
) -> Result<Json<AiKeySummary>, ApiError> {
    manager(&state)?;
    keys::set_active(&state.db, &user.id, body.provider)
        .await
        .map_err(|error| match error {
            KeyStoreError::NoKeyForProvider => ApiError::ApiKeyRequired,
            other => internal(other),
        })?;
    summary_for(&state, &user.id).await
}
