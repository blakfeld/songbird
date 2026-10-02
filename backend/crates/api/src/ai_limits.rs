//! Per-user limits on every endpoint that calls a paid AI provider. The minute
//! window is in memory; the daily count is stored so a deploy-time restart does
//! not refill it.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use tokio::time::Instant;

use crate::auth::http::CurrentUser;
use crate::clock::now_ms;
use crate::db::Db;
use crate::error::{ApiError, NeverReachedProvider};
use crate::state::AppState;

const MINUTE: Duration = Duration::from_secs(60);
const DAY_MS: i64 = 86_400_000;

pub struct AiLimiter {
    windows: Mutex<HashMap<String, VecDeque<Instant>>>,
    window: Duration,
}

impl Default for AiLimiter {
    fn default() -> Self {
        Self::with_window(MINUTE)
    }
}

impl AiLimiter {
    /// Also bounds other per-user abuse windows, such as saving provider keys, so they share
    /// one tested implementation.
    pub fn with_window(window: Duration) -> Self {
        Self {
            windows: Mutex::default(),
            window,
        }
    }

    pub fn try_record(&self, user_id: &str, limit: u32) -> Result<(), u64> {
        let now = Instant::now();
        let mut windows = self.windows.lock().expect("ai limiter lock");
        let window = windows.entry(user_id.to_string()).or_default();
        while window
            .front()
            .is_some_and(|at| now.duration_since(*at) >= self.window)
        {
            window.pop_front();
        }
        if window.len() >= limit as usize {
            let oldest = *window.front().expect("a full window is not empty");
            let wait = (oldest + self.window).saturating_duration_since(now);
            return Err(wait.as_secs() + 1);
        }
        window.push_back(now);
        Ok(())
    }
}

/// Counted before the provider is called because a failed or timed-out call still costs money.
async fn count_today(db: &Db, user_id: &str, day: i32) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO ai_usage (user_id, day, count) VALUES ($1, $2, 1) \
         ON CONFLICT (user_id, day) DO UPDATE SET count = ai_usage.count + 1 \
         RETURNING CAST(count AS BIGINT)",
    )
    .bind(user_id)
    .bind(day)
    .fetch_one(db.pool())
    .await?;
    sqlx::Row::try_get(&row, 0)
}

/// A request that ends because the user has no usable stored key never reached a provider, so
/// it must not eat the daily budget the user will need once they add one.
async fn refund_today(db: &Db, user_id: &str, day: i32) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE ai_usage SET count = count - 1 WHERE user_id = $1 AND day = $2 AND count > 0",
    )
    .bind(user_id)
    .bind(day)
    .execute(db.pool())
    .await?;
    Ok(())
}

pub async fn meter(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let user = request
        .extensions()
        .get::<CurrentUser>()
        .cloned()
        .ok_or(ApiError::Unauthenticated)?;

    state
        .ai_limiter
        .try_record(&user.id, state.config.ai_requests_per_minute)
        .map_err(|retry_after| ApiError::TooManyRequests { retry_after })?;

    let now = now_ms();
    let day = i32::try_from(now / DAY_MS).map_err(|_| ApiError::Internal)?;
    let used = count_today(&state.db, &user.id, day)
        .await
        .map_err(|error| {
            tracing::error!(%error, "could not count AI usage");
            ApiError::Internal
        })?;
    if used > i64::from(state.config.ai_requests_per_day) {
        let until_midnight_ms = (i64::from(day) + 1) * DAY_MS - now;
        return Err(ApiError::TooManyRequests {
            retry_after: u64::try_from(until_midnight_ms / 1000).unwrap_or(0) + 1,
        });
    }
    let response = next.run(request).await;
    if response
        .extensions()
        .get::<NeverReachedProvider>()
        .is_some()
    {
        if let Err(error) = refund_today(&state.db, &user.id, day).await {
            tracing::error!(%error, "could not refund AI usage");
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn window_admits_up_to_the_limit_then_reports_when_a_slot_frees() {
        let limiter = AiLimiter::default();
        for _ in 0..3 {
            limiter.try_record("u", 3).unwrap();
        }
        let wait = limiter.try_record("u", 3).unwrap_err();
        assert!((1..=61).contains(&wait));
        assert!(limiter.try_record("other", 3).is_ok());

        tokio::time::advance(MINUTE + Duration::from_secs(1)).await;
        assert!(limiter.try_record("u", 3).is_ok());
    }
}
