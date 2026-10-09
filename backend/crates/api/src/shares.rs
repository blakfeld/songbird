//! Kept apart from `listen` so the session-gated owner routes and the token-only public
//! routes never share a handler module, which would make it easy to reach for owner state
//! from an unauthenticated path.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::http::CurrentUser;
use crate::clock::now_ms;
use crate::error::{ApiError, ApiJson};
use crate::share_store::{
    self as store, NewShare, OwnerComment, ShareEdit, ShareError, ShareMode, ShareSummary,
};
use crate::state::AppState;
use crate::token::generate_token;

const LABEL_MAX_CHARS: usize = 80;
const MAX_EXPIRY_MS: i64 = 365 * 24 * 3600 * 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/projects/{id}/shares", get(list).post(create))
        .route(
            "/api/v1/projects/{id}/shares/{share_id}",
            put(update).delete(revoke),
        )
        .route("/api/v1/projects/{id}/comments", get(list_comments))
        .route(
            "/api/v1/projects/{id}/comments/{comment_id}",
            put(resolve_comment).delete(delete_comment),
        )
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ModeField {
    Live,
    Snapshot,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    mode: ModeField,
    expires_at: Option<i64>,
    allow_comments: bool,
    allow_downloads: bool,
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    label: Option<String>,
    expires_at: Option<i64>,
    allow_comments: bool,
    allow_downloads: bool,
}

#[derive(Deserialize)]
struct ResolveBody {
    resolved: bool,
}

/// Bodies arrive as raw JSON so a wrong shape is reported as `invalid_share`
/// (422) like every other bad setting, rather than as malformed JSON (400).
fn parse_settings<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, ApiError> {
    serde_json::from_value(body).map_err(|error| ApiError::InvalidShare(error.to_string()))
}

fn validated_label(label: Option<String>) -> Result<String, ApiError> {
    let label = label.unwrap_or_default().trim().to_string();
    if label.chars().count() > LABEL_MAX_CHARS {
        return Err(ApiError::InvalidShare(format!(
            "the label is at most {LABEL_MAX_CHARS} characters"
        )));
    }
    if label.chars().any(char::is_control) {
        return Err(ApiError::InvalidShare(
            "the label cannot contain control characters".into(),
        ));
    }
    Ok(label)
}

fn validated_expiry(expires_at: Option<i64>, now: i64) -> Result<Option<i64>, ApiError> {
    let Some(at) = expires_at else {
        return Ok(None);
    };
    if at <= now {
        return Err(ApiError::InvalidShare(
            "expires_at must be in the future".into(),
        ));
    }
    if at > now.saturating_add(MAX_EXPIRY_MS) {
        return Err(ApiError::InvalidShare(
            "expires_at must be within 365 days".into(),
        ));
    }
    Ok(Some(at))
}

fn failure(error: ShareError, missing: ApiError) -> ApiError {
    match error {
        ShareError::NotFound => missing,
        ShareError::ShareLimit => ApiError::ShareLimit,
        ShareError::ProjectLimit => ApiError::ProjectLimit,
        ShareError::CommentLimit => ApiError::CommentLimit,
        ShareError::Projection(reason) => {
            tracing::error!(%reason, "a stored song could not be shared");
            ApiError::Internal
        }
        ShareError::Database(error) => {
            tracing::error!(%error, "share storage failed");
            ApiError::Internal
        }
    }
}

fn share_json(share: &ShareSummary, now: i64) -> Value {
    json!({
        "id": share.id,
        "token_prefix": share.token_prefix,
        "mode": share.mode.as_str(),
        "label": share.label,
        "allow_comments": share.allow_comments,
        "allow_downloads": share.allow_downloads,
        "expires_at": share.expires_at,
        "created_at": share.created_at,
        "revoked_at": share.revoked_at,
        "status": share.status(now).as_str(),
        "unresolved_comments": share.unresolved_comments,
    })
}

fn comment_json(comment: &OwnerComment) -> Value {
    json!({
        "id": comment.id,
        "share_id": comment.share_id,
        "share_label": comment.share_label,
        "token_prefix": comment.token_prefix,
        "name": comment.name,
        "body": comment.body,
        "at_step": comment.at_step,
        "section_id": comment.section_id,
        "section_name": comment.section_name,
        "project_revision": comment.project_revision,
        "created_at": comment.created_at,
        "resolved_at": comment.resolved_at,
    })
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Response, ApiError> {
    let body: CreateBody = parse_settings(body)?;
    let now = now_ms();
    let new = NewShare {
        mode: match body.mode {
            ModeField::Live => ShareMode::Live,
            ModeField::Snapshot => ShareMode::Snapshot,
        },
        label: validated_label(body.label)?,
        expires_at: validated_expiry(body.expires_at, now)?,
        allow_comments: body.allow_comments,
        allow_downloads: body.allow_downloads,
    };
    let token = generate_token();
    let share = store::create(
        &state.db,
        &user.id,
        &project_id,
        &new,
        token.expose_secret(),
    )
    .await
    .map_err(|error| failure(error, ApiError::ProjectNotFound))?;
    // Only the id is logged: the token is shown to the owner once and nowhere else.
    tracing::info!(share_id = %share.id, "share link created");
    let url = format!("/listen/{}", token.expose_secret());
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "share": share_json(&share, now),
            "token": token.expose_secret(),
            "url": url,
        })),
    )
        .into_response())
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let now = now_ms();
    let shares = store::list(&state.db, &user.id, &project_id)
        .await
        .map_err(|error| failure(error, ApiError::ProjectNotFound))?;
    let shares: Vec<Value> = shares.iter().map(|s| share_json(s, now)).collect();
    Ok(Json(json!({"shares": shares})))
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, share_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<Value>, ApiError> {
    let body: UpdateBody = parse_settings(body)?;
    let now = now_ms();
    let current = store::get(&state.db, &user.id, &project_id, &share_id)
        .await
        .map_err(|error| failure(error, ApiError::ShareNotFound))?;
    // An unchanged expiry is accepted even when it has passed, so the owner can
    // still change the other settings of an expired link without reviving it.
    let expires_at = if body.expires_at == current.expires_at {
        body.expires_at
    } else {
        validated_expiry(body.expires_at, now)?
    };
    let edit = ShareEdit {
        label: validated_label(body.label)?,
        expires_at,
        allow_comments: body.allow_comments,
        allow_downloads: body.allow_downloads,
    };
    let share = store::update(&state.db, &user.id, &project_id, &share_id, &edit)
        .await
        .map_err(|error| failure(error, ApiError::ShareNotFound))?;
    Ok(Json(json!({"share": share_json(&share, now)})))
}

async fn revoke(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, share_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    store::revoke(&state.db, &user.id, &project_id, &share_id)
        .await
        .map_err(|error| failure(error, ApiError::ShareNotFound))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_comments(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let comments = store::list_comments(&state.db, &user.id, &project_id)
        .await
        .map_err(|error| failure(error, ApiError::ProjectNotFound))?;
    let comments: Vec<Value> = comments.iter().map(comment_json).collect();
    Ok(Json(json!({"comments": comments})))
}

async fn resolve_comment(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, comment_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<ResolveBody>,
) -> Result<Json<Value>, ApiError> {
    let comment =
        store::set_comment_resolved(&state.db, &user.id, &project_id, &comment_id, body.resolved)
            .await
            .map_err(|error| failure(error, ApiError::CommentNotFound))?;
    Ok(Json(json!({"comment": comment_json(&comment)})))
}

async fn delete_comment(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, comment_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    store::delete_comment(&state.db, &user.id, &project_id, &comment_id)
        .await
        .map_err(|error| failure(error, ApiError::CommentNotFound))?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_must_be_in_the_future_and_within_a_year() {
        let now = 1_000_000;
        assert_eq!(validated_expiry(None, now).unwrap(), None);
        assert!(validated_expiry(Some(now), now).is_err());
        assert!(validated_expiry(Some(now - 60_000), now).is_err());
        assert_eq!(
            validated_expiry(Some(now + MAX_EXPIRY_MS), now).unwrap(),
            Some(now + MAX_EXPIRY_MS)
        );
        assert!(validated_expiry(Some(now + MAX_EXPIRY_MS + 1), now).is_err());
    }

    #[test]
    fn label_is_trimmed_and_limited_in_characters() {
        assert_eq!(validated_label(None).unwrap(), "");
        assert_eq!(validated_label(Some("  Sam  ".into())).unwrap(), "Sam");
        assert!(validated_label(Some("é".repeat(80))).is_ok());
        assert!(validated_label(Some("é".repeat(81))).is_err());
        assert!(validated_label(Some("a\u{7}b".into())).is_err());
    }
}
