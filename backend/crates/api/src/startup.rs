//! Everything that can fail before the service accepts traffic lives here, so
//! tests exercise the same path as `main` without binding a port.

use std::sync::Arc;

use music::InstrumentRegistry;

use crate::config::{Config, MASTER_KEYS};
use crate::db::Db;
use crate::provider::build_ai_access;
use crate::state::AppState;

/// Connects and migrates the database before anything listens, so a bad
/// database stops startup rather than failing the first request.
pub async fn build_state(config: Config) -> Result<AppState, String> {
    for warning in config.startup_warnings() {
        tracing::warn!("{warning}");
    }
    let db = Db::connect(&config.database)
        .await
        .map_err(|e| e.to_string())?;
    if config.ai_provider.is_per_user() {
        check_stored_key_versions(&config, &db).await?;
    }
    let ai = build_ai_access(&config).await.map_err(|e| e.to_string())?;
    Ok(AppState::with_ai(
        ai,
        InstrumentRegistry::builtin(),
        Arc::new(config),
        db,
    ))
}

/// Without this, removing an old master key surfaces later as every affected user's AI
/// failing with `api_key_invalid`, with no hint that the operator caused it.
async fn check_stored_key_versions(config: &Config, db: &Db) -> Result<(), String> {
    let Some(keyring) = &config.master_keys else {
        return Ok(());
    };
    let in_use = crate::keys::key_versions_in_use(db)
        .await
        .map_err(|e| e.to_string())?;
    let missing: Vec<&str> = in_use
        .iter()
        .map(String::as_str)
        .filter(|v| keyring.get(v).is_none())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "stored AI keys use master key version(s) {} that are missing from {MASTER_KEYS}. \
         Add the old key back to the list and run `api keys rotate`, or, if it is lost, run \
         `api keys purge --version <version>` to delete the keys sealed under it",
        missing.join(", ")
    ))
}
