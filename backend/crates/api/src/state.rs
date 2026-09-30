use std::sync::Arc;

use music::ai::PatternProvider;
use music::InstrumentRegistry;

use crate::config::Config;

/// Handlers take everything from here so tests can swap in a fake provider
/// without touching the environment.
#[derive(Clone)]
pub struct AppState {
    pub provider: Arc<dyn PatternProvider>,
    pub instruments: InstrumentRegistry,
    pub config: Arc<Config>,
}
