use axum::extract::State;
use axum::routing::put;
use axum::{Json, Router};
use serde_json::Value;

use crate::auth::http::{user_json, CurrentUser};
use crate::error::{ApiError, ApiJson};
use crate::state::AppState;
use crate::users::{self, UserError};

/// Few enough that cycling through names to pass as another commenter is slow, and plenty for
/// fixing a typo.
const USERNAME_CHANGES_PER_HOUR: u32 = 5;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/account/username", put(set_username))
}

async fn set_username(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<Value>, ApiError> {
    // Checked up front but spent only by a real change: a user hunting for a free name must
    // not lock themselves out of commenting by trying names that are taken or invalid.
    state
        .username_limiter
        .check(&user.id, USERNAME_CHANGES_PER_HOUR)
        .map_err(|retry_after| ApiError::TooManyRequests { retry_after })?;

    // Read by hand so a wrong shape is `invalid_username`, the code the form already handles.
    let requested = body
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidUsername("Send the username as a string.".to_string()))?;
    let username = users::set_username(&state.db, &user.id, requested)
        .await
        .map_err(|error| match error {
            UserError::InvalidUsername(message) => ApiError::InvalidUsername(message),
            UserError::UsernameTaken => ApiError::UsernameTaken,
            other => {
                tracing::error!(error = %other, "could not set the username");
                ApiError::Internal
            }
        })?;
    if user.username.as_deref() != Some(username.as_str()) {
        state.username_limiter.record(&user.id);
    }
    Ok(Json(user_json(&user.id, &user.email, Some(&username))))
}
