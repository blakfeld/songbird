use std::sync::Arc;

use music::InstrumentRegistry;

use crate::ai_limits::AiLimiter;
use crate::auth::password::PasswordService;
use crate::auth::throttle::LoginThrottle;
use crate::config::Config;
use crate::db::Db;
use crate::provider::Providers;

/// Handlers take everything from here so tests can swap in a fake provider
/// without touching the environment.
#[derive(Clone)]
pub struct AppState {
    pub providers: Providers,
    pub instruments: InstrumentRegistry,
    pub config: Arc<Config>,
    pub db: Db,
    pub passwords: PasswordService,
    pub login_throttle: Arc<LoginThrottle>,
    pub ai_limiter: Arc<AiLimiter>,
}

impl AppState {
    /// Fields stay public so a test can swap one, such as a cheaper password service.
    pub fn new(
        providers: Providers,
        instruments: InstrumentRegistry,
        config: Arc<Config>,
        db: Db,
    ) -> Self {
        Self {
            providers,
            instruments,
            config,
            db,
            passwords: PasswordService::new(),
            login_throttle: Arc::new(LoginThrottle::default()),
            ai_limiter: Arc::new(AiLimiter::default()),
        }
    }
}
