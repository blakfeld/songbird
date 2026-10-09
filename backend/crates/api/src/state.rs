use std::sync::Arc;
use std::time::Duration;

use music::InstrumentRegistry;

use crate::ai_access::{AiAccess, RealUserProviders, UserProviders};
use crate::ai_limits::AiLimiter;
use crate::auth::password::PasswordService;
use crate::auth::throttle::LoginThrottle;
use crate::config::Config;
use crate::db::Db;
use crate::provider::Providers;
use crate::share_throttle::{ShareLimits, ShareThrottle};

/// Handlers take everything from here so tests can swap in a fake provider
/// without touching the environment.
#[derive(Clone)]
pub struct AppState {
    pub ai: AiAccess,
    pub instruments: InstrumentRegistry,
    pub config: Arc<Config>,
    pub db: Db,
    pub passwords: PasswordService,
    pub login_throttle: Arc<LoginThrottle>,
    pub ai_limiter: Arc<AiLimiter>,
    /// Counts every save attempt, not only failures, so the endpoint is no oracle for stolen keys.
    pub key_save_limiter: Arc<AiLimiter>,
    pub share_throttle: Arc<ShareThrottle>,
    /// Lets keys be managed in development with an operator provider, where `ai` has no factory.
    pub shared_key_checker: Arc<dyn UserProviders>,
}

/// Names the parts that are safe to show, so no future field is printed by default.
impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("ai", &self.ai)
            .field("config", &self.config)
            .field("database", &self.db.backend())
            .finish_non_exhaustive()
    }
}

const KEY_SAVE_WINDOW: Duration = Duration::from_secs(3600);

impl AppState {
    /// A shared provider for every user, which is how tests and development run. Fields stay
    /// public so a test can swap one, such as a cheaper password service.
    pub fn new(
        providers: Providers,
        instruments: InstrumentRegistry,
        config: Arc<Config>,
        db: Db,
    ) -> Self {
        Self::with_ai(AiAccess::Shared(providers), instruments, config, db)
    }

    pub fn with_ai(
        ai: AiAccess,
        instruments: InstrumentRegistry,
        config: Arc<Config>,
        db: Db,
    ) -> Self {
        let share_throttle = Arc::new(ShareThrottle::new(ShareLimits::from_config(&config)));
        Self {
            shared_key_checker: Arc::new(RealUserProviders::new(&config)),
            ai,
            instruments,
            config,
            db,
            passwords: PasswordService::new(),
            login_throttle: Arc::new(LoginThrottle::default()),
            ai_limiter: Arc::new(AiLimiter::default()),
            key_save_limiter: Arc::new(AiLimiter::with_window(KEY_SAVE_WINDOW)),
            share_throttle,
        }
    }
}
