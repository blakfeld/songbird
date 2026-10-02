use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use music::{Song, SongError};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::http::CurrentUser;
use crate::error::{ApiError, ApiJson};
use crate::project_store::{self as store, ProjectError, SongFacts, Stored};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/projects", get(list).post(create))
        .route("/api/v1/projects/{id}", get(open).put(save).delete(remove))
}

#[derive(Deserialize)]
struct CreateBody {
    song: Value,
}

#[derive(Deserialize)]
struct SaveBody {
    song: Value,
    revision: i64,
}

impl From<ProjectError> for ApiError {
    fn from(error: ProjectError) -> Self {
        match error {
            ProjectError::NotFound => Self::ProjectNotFound,
            ProjectError::RevisionConflict => Self::RevisionConflict,
            ProjectError::Limit => Self::ProjectLimit,
            ProjectError::TooSoon { retry_after_secs } => Self::TooManyRequests {
                retry_after: retry_after_secs,
            },
            ProjectError::Database(error) => {
                tracing::error!(%error, "project storage failed");
                Self::Internal
            }
        }
    }
}

/// The caller's JSON is stored, not the typed struct: round-tripping would drop
/// fields this version does not know, which the project-file spec forbids.
fn validated_facts(state: &AppState, song: &Value) -> Result<(Song, SongFacts), ApiError> {
    let typed: Song = serde_json::from_value(song.clone()).map_err(|_| ApiError::InvalidJson)?;
    typed
        .validate(&state.instruments)
        .map_err(|error| match error {
            SongError::UnknownInstrument { message } => ApiError::InvalidSongInstrument(message),
            SongError::Invalid { message, .. } => ApiError::InvalidSong(message),
        })?;
    let facts = SongFacts {
        name: typed.name.clone(),
        time_signature: typed.time_signature.as_str().to_string(),
        track_count: i32::try_from(typed.tracks.len()).unwrap_or(i32::MAX),
        song_json: song.to_string(),
    };
    Ok((typed, facts))
}

fn project_json(stored: &Stored) -> Result<Value, ApiError> {
    let song: Value = serde_json::from_str(&stored.song).map_err(|error| {
        tracing::error!(%error, "a stored song is not valid JSON");
        ApiError::Internal
    })?;
    Ok(json!({"project": {
        "id": stored.id,
        "revision": stored.revision,
        "updated_at": stored.updated_at,
        "song": song,
    }}))
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, ApiError> {
    let projects = store::list(&state.db, &user.id).await?;
    let entries: Vec<Value> = projects
        .into_iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "time_signature": p.time_signature,
                "track_count": p.track_count,
                "revision": p.revision,
                "updated_at": p.updated_at,
            })
        })
        .collect();
    Ok(Json(json!({"projects": entries})))
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<CreateBody>,
) -> Result<Response, ApiError> {
    // The server owns the id: the client cannot know it yet and must not be
    // able to pick one that collides with another user's project.
    let id = uuid::Uuid::now_v7().to_string();
    let mut song = body.song;
    let Some(object) = song.as_object_mut() else {
        return Err(ApiError::InvalidJson);
    };
    object.insert("id".into(), Value::String(id.clone()));

    let (_, facts) = validated_facts(&state, &song)?;
    let stored = store::create(&state.db, &user.id, &id, &facts).await?;
    Ok((StatusCode::CREATED, Json(project_json(&stored)?)).into_response())
}

async fn open(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let stored = store::get(&state.db, &user.id, &id).await?;
    Ok(Json(project_json(&stored)?))
}

async fn save(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SaveBody>,
) -> Result<Json<Value>, ApiError> {
    let (typed, facts) = validated_facts(&state, &body.song)?;
    // Refused rather than overwritten: a mismatch means the client is confused
    // about which project it is editing, and saving would put one song's
    // content into another project.
    if typed.id != id {
        return Err(ApiError::IdMismatch);
    }
    let saved = store::update(&state.db, &user.id, &id, body.revision, &facts).await?;
    Ok(Json(json!({
        "revision": saved.revision,
        "updated_at": saved.updated_at,
    })))
}

async fn remove(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    store::delete(&state.db, &user.id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
