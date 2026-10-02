//! Everything that can fail before the service accepts traffic lives here, so
//! tests exercise the same path as `main` without binding a port.

use std::sync::Arc;

use music::InstrumentRegistry;

use crate::config::Config;
use crate::db::Db;
use crate::provider::build_providers;
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
    let providers = build_providers(&config).await.map_err(|e| e.to_string())?;
    Ok(AppState::new(
        providers,
        InstrumentRegistry::builtin(),
        Arc::new(config),
        db,
    ))
}
