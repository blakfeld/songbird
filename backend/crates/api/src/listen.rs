//! Public routes reached with a share token. Nothing here builds a
//! `CurrentUser` or reads a cookie, so no handler can touch owner state by
//! accident, and nothing logs a token or a comment.

use std::net::SocketAddr;

use axum::extract::connect_info::ConnectInfo;
use axum::extract::rejection::ExtensionRejection;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use music::{InstrumentInfo, Song, SongError};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::http::client_address;
use crate::auth::throttle::client_key;
use crate::clock::now_ms;
use crate::error::{ApiError, ApiJson};
use crate::share_store::{self as store, ActiveShare, NewComment, ShareError};
use crate::songs::midi_response;
use crate::state::AppState;

/// A comment is at most 2,000 characters of body plus a short name, so this
/// leaves room for multi-byte text while refusing anything larger early.
pub const COMMENT_BODY_LIMIT: usize = 8 * 1024;

const NAME_MAX_CHARS: usize = 40;
const BODY_MAX_CHARS: usize = 2_000;
const BODY_MAX_LINES: usize = 30;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/listen/{token}", get(show))
        .route("/api/v1/listen/{token}/midi", get(midi))
        .route(
            "/api/v1/listen/{token}/comments",
            post(post_comment).layer(DefaultBodyLimit::max(COMMENT_BODY_LIMIT)),
        )
}

/// Runs before the body is read or the token looked up, so a flood costs no
/// database work and an invalid comment still counts toward the limit.
pub async fn throttle(
    State(state): State<AppState>,
    peer: Result<ConnectInfo<SocketAddr>, ExtensionRejection>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let address = client_key(client_address(
        &state,
        request.headers(),
        peer.ok().map(|ConnectInfo(addr)| addr),
    ));
    let admitted = match *request.method() {
        Method::GET | Method::HEAD => state.share_throttle.check_read(&address),
        Method::POST => state.share_throttle.check_comment_address(&address),
        _ => Ok(()),
    };
    admitted.map_err(|throttled| ApiError::TooManyRequests {
        retry_after: throttled.retry_after_secs,
    })?;
    Ok(next.run(request).await)
}

/// Unknown, malformed, revoked, and expired tokens all end here with one
/// answer, so a response never reveals that a link once existed.
async fn active_share(state: &AppState, token: &str) -> Result<ActiveShare, ApiError> {
    store::find_active(&state.db, token, now_ms())
        .await
        .map_err(|error| match error {
            ShareError::Database(error) => {
                tracing::error!(%error, "share lookup failed");
                ApiError::Internal
            }
            other => {
                tracing::error!(error = %other, "a shared song could not be served");
                ApiError::Internal
            }
        })?
        .ok_or(ApiError::NotFound)
}

fn served_song(share: &ActiveShare) -> Result<Song, ApiError> {
    store::parse_projected(&share.song).map_err(|error| {
        tracing::error!(
            kind = store::json_error_kind(&error),
            "a shared song is not a valid song"
        );
        ApiError::Internal
    })
}

fn instruments_used(state: &AppState, song: &Song) -> Vec<InstrumentInfo> {
    let mut seen: Vec<&str> = Vec::new();
    let mut infos = Vec::new();
    for track in &song.tracks {
        if seen.contains(&track.instrument.as_str()) {
            continue;
        }
        seen.push(&track.instrument);
        if let Some(instrument) = state.instruments.get(&track.instrument) {
            infos.push(instrument.info());
        }
    }
    infos
}

async fn show(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let share = active_share(&state, &token).await?;
    let song = served_song(&share)?;
    Ok(Json(json!({
        "share": {
            "mode": share.mode.as_str(),
            "allow_comments": share.allow_comments,
            "allow_downloads": share.allow_downloads,
            "expires_at": share.expires_at,
        },
        "song": share.song,
        "instruments": instruments_used(&state, &song),
        "shared_at": share.shared_at,
    })))
}

async fn midi(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, ApiError> {
    let share = active_share(&state, &token).await?;
    if !share.allow_downloads {
        return Err(ApiError::NotFound);
    }
    let song = served_song(&share)?;
    let valid = song.validate(&state.instruments).map_err(|error| {
        // The error text can quote the owner's song, so only its kind is logged.
        let kind = match error {
            SongError::UnknownInstrument { .. } => "unknown_instrument",
            SongError::Invalid { .. } => "invalid",
        };
        tracing::error!(kind, "a shared song no longer validates");
        ApiError::Internal
    })?;
    midi_response(&valid)
}

/// Unknown fields are refused, but as `invalid_comment` rather than malformed
/// JSON, so the listen page shows one kind of message for any bad comment.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommentBody {
    name: String,
    body: String,
    at_step: i64,
    website: Option<String>,
}

/// Same chunking as the frontend's `implicitSections`, so a comment on an unsectioned song
/// names the section the listener saw.
const IMPLICIT_SECTION_MEASURES: u32 = 32;

struct Located {
    /// Absent for implicit chunks, which have no stored section to point at.
    id: Option<String>,
    name: String,
}

/// The song's end belongs to the last section so a comment on the final beat still gets a name.
fn locate(song: &Song, at_step: u32) -> Located {
    let steps_per_measure = u64::from(song.steps_per_measure);
    let step = u64::from(at_step);
    if song.sections.is_empty() {
        let chunk_steps = u64::from(IMPLICIT_SECTION_MEASURES) * steps_per_measure;
        let chunks = u64::from(song.measures.div_ceil(IMPLICIT_SECTION_MEASURES)).max(1);
        let index = (step / chunk_steps).min(chunks - 1);
        let name = if index == 0 {
            "Song".to_string()
        } else {
            format!("Song {}", index + 1)
        };
        return Located { id: None, name };
    }
    let mut end = 0u64;
    let mut found = None;
    for section in &song.sections {
        end += u64::from(section.measures) * steps_per_measure;
        if step < end {
            found = Some(section);
            break;
        }
    }
    let section = found.or(song.sections.last()).expect("sections not empty");
    Located {
        id: Some(section.id.clone()),
        name: section.name.clone(),
    }
}

/// Bidirectional overrides and isolates are refused because they make plain
/// text display differently from what it says.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn invalid(message: &str) -> ApiError {
    ApiError::InvalidComment(message.to_string())
}

fn validated_name(name: &str) -> Result<String, ApiError> {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let length = collapsed.chars().count();
    if length == 0 || length > NAME_MAX_CHARS {
        return Err(invalid(&format!(
            "Enter a name of 1 to {NAME_MAX_CHARS} characters."
        )));
    }
    if collapsed
        .chars()
        .any(|c| c.is_control() || is_bidi_control(c))
    {
        return Err(invalid(
            "The name contains characters that are not allowed.",
        ));
    }
    Ok(collapsed)
}

fn validated_body(body: &str) -> Result<String, ApiError> {
    let body = body.trim();
    let length = body.chars().count();
    if length == 0 || length > BODY_MAX_CHARS {
        return Err(invalid(&format!(
            "Write a comment of 1 to {BODY_MAX_CHARS} characters."
        )));
    }
    if body.split('\n').count() > BODY_MAX_LINES {
        return Err(invalid(&format!(
            "A comment can have at most {BODY_MAX_LINES} lines."
        )));
    }
    if body
        .chars()
        .any(|c| (c.is_control() && c != '\n') || is_bidi_control(c))
    {
        return Err(invalid(
            "The comment contains characters that are not allowed.",
        ));
    }
    Ok(body.to_string())
}

fn validated_step(at_step: i64, song: &Song) -> Result<u32, ApiError> {
    u32::try_from(at_step)
        .ok()
        .filter(|step| *step <= song.total_steps())
        .ok_or_else(|| invalid("The position is outside the song."))
}

async fn post_comment(
    State(state): State<AppState>,
    Path(token): Path<String>,
    ApiJson(raw): ApiJson<Value>,
) -> Result<Response, ApiError> {
    let share = active_share(&state, &token).await?;
    if !share.allow_comments {
        return Err(ApiError::NotFound);
    }
    // Checked here and recorded only after the insert, so concurrent posts can overshoot by a few.
    // That is tolerated because the per-address limits and the 1,000-comment cap bound the excess,
    // and holding a lock across the database insert would cost more than it protects.
    state
        .share_throttle
        .check_comment_share(&share.id)
        .map_err(|throttled| ApiError::TooManyRequests {
            retry_after: throttled.retry_after_secs,
        })?;

    let body: CommentBody = serde_json::from_value(raw)
        .map_err(|_| invalid("The comment is missing a field or has an unexpected one."))?;
    let song = served_song(&share)?;

    // Before validation, so a bot cannot tell a rejected comment from a stored one.
    if body.website.as_deref().is_some_and(|w| !w.is_empty()) {
        let section = u32::try_from(body.at_step)
            .ok()
            .map(|step| locate(&song, step));
        return Ok(created(
            &uuid::Uuid::now_v7().to_string(),
            body.name.trim(),
            body.body.trim(),
            body.at_step,
            section.as_ref().map(|s| s.name.as_str()),
            now_ms(),
        ));
    }

    let name = validated_name(&body.name)?;
    let text = validated_body(&body.body)?;
    let at_step = validated_step(body.at_step, &song)?;
    let section = locate(&song, at_step);

    let new = NewComment {
        name,
        body: text,
        at_step: i64::from(at_step),
        section_id: section.id,
        section_name: Some(section.name),
        project_revision: share.project_revision,
    };
    let stored = store::add_comment(&state.db, &share.id, &share.project_id, &new)
        .await
        .map_err(|error| match error {
            ShareError::CommentLimit => ApiError::CommentLimit,
            // The owner revoked the link, switched comments off, or it expired after the lookup.
            ShareError::NotFound => ApiError::NotFound,
            other => {
                tracing::error!(error = %other, "storing a comment failed");
                ApiError::Internal
            }
        })?;
    state.share_throttle.record_comment_share(&share.id);
    Ok(created(
        &stored.id,
        &new.name,
        &new.body,
        new.at_step,
        new.section_name.as_deref(),
        stored.created_at,
    ))
}

fn created(
    id: &str,
    name: &str,
    body: &str,
    at_step: i64,
    section_name: Option<&str>,
    created_at: i64,
) -> Response {
    (
        StatusCode::CREATED,
        Json(json!({"comment": {
            "id": id,
            "name": name,
            "body": body,
            "at_step": at_step,
            "section_name": section_name,
            "created_at": created_at,
        }})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song_with_sections(measures: &[u32]) -> Song {
        let sections: Vec<Value> = measures
            .iter()
            .enumerate()
            .map(|(i, m)| {
                json!({"id": format!("s{i}"), "name": format!("Section {i}"),
                       "kind": "verse", "measures": m, "notes": ""})
            })
            .collect();
        serde_json::from_value(json!({
            "version": 2, "id": "x", "name": "x", "tempo_bpm": 96,
            "time_signature": "4/4", "steps_per_measure": 16, "swing": 0,
            "measures": measures.iter().sum::<u32>(), "tracks": [], "sections": sections,
        }))
        .unwrap()
    }

    #[test]
    fn sections_are_found_by_step_and_the_end_belongs_to_the_last() {
        let song = song_with_sections(&[2, 4]);
        let name = |step| locate(&song, step).name;
        assert_eq!(name(0), "Section 0");
        assert_eq!(name(31), "Section 0");
        assert_eq!(name(32), "Section 1");
        assert_eq!(name(96), "Section 1");
        assert_eq!(locate(&song, 32).id.as_deref(), Some("s1"));
    }

    #[test]
    fn an_unsectioned_song_is_chunked_like_the_frontend_without_a_section_id() {
        let mut song = song_with_sections(&[]);
        song.measures = 70;
        let at = |step| locate(&song, step);
        assert_eq!(at(0).name, "Song");
        assert_eq!(at(32 * 16 - 1).name, "Song");
        assert_eq!(at(32 * 16).name, "Song 2");
        assert_eq!(at(64 * 16).name, "Song 3");
        assert_eq!(at(70 * 16).name, "Song 3");
        assert!(at(0).id.is_none() && at(64 * 16).id.is_none());

        song.measures = 32;
        assert_eq!(locate(&song, 32 * 16).name, "Song");
    }

    #[test]
    fn names_collapse_whitespace_and_refuse_overrides() {
        assert_eq!(validated_name("  Sam \t  Jones ").unwrap(), "Sam Jones");
        assert!(validated_name("   ").is_err());
        assert!(validated_name(&"x".repeat(41)).is_err());
        assert!(validated_name(&"é".repeat(40)).is_ok());
        assert!(validated_name("Sam\u{202E}").is_err());
        assert!(validated_name("Sam\u{0}").is_err());
        assert!(validated_name("Sam\u{2067}").is_err());
    }

    #[test]
    fn bodies_keep_line_breaks_but_not_other_control_characters() {
        assert_eq!(validated_body("  hi\nthere \n").unwrap(), "hi\nthere");
        assert!(validated_body(" \n ").is_err());
        assert!(validated_body(&"x".repeat(2001)).is_err());
        assert!(validated_body(&"é".repeat(2000)).is_ok());
        assert!(validated_body("a\n".repeat(30).trim_end()).is_ok());
        assert!(validated_body(&"a\n".repeat(31)).is_err());
        assert!(validated_body("tab\there").is_err());
        assert!(validated_body("cr\rhere").is_err());
        assert!(validated_body("x\u{202A}").is_err());
        assert_eq!(
            validated_body("<img src=x onerror=alert(1)>").unwrap(),
            "<img src=x onerror=alert(1)>"
        );
    }
}
