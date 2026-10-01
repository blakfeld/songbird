use std::sync::Arc;

use music::InstrumentRegistry;

use crate::config::Config;
use crate::provider::Providers;

/// Handlers take everything from here so tests can swap in a fake provider
/// without touching the environment.
#[derive(Clone)]
pub struct AppState {
    pub providers: Providers,
    pub instruments: InstrumentRegistry,
    pub config: Arc<Config>,
}
