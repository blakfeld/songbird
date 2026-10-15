//! Listen endpoints that act for a signed-in user. They sit behind the session layer, unlike
//! the public reads in `listen`, so a handler here cannot run without a `CurrentUser`.
//! Nothing here logs a token or a comment.

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use music::song::SONG_NAME_MAX;
use music::Song;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::http::CurrentUser;
use crate::auth::throttle::Throttled;
use crate::error::{ApiError, ApiJson};
use crate::listen::{active_share, served_song};
use crate::projects::{create_project, project_json};
use crate::share_store::{self as store, NewComment, ShareError};
use crate::state::AppState;

/// A comment is at most 2,000 characters of body, so this leaves room for multi-byte text
/// while refusing anything larger early.
pub const COMMENT_BODY_LIMIT: usize = 8 * 1024;

const BODY_MAX_CHARS: usize = 2_000;
const BODY_MAX_LINES: usize = 30;
const REMIX_SUFFIX: &str = " (remix)";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/listen/{token}/comments",
            post(post_comment).layer(DefaultBodyLimit::max(COMMENT_BODY_LIMIT)),
        )
        .route("/api/v1/listen/{token}/remix", post(remix))
}

/// Unknown fields are refused, but as `invalid_comment` rather than malformed
/// JSON, so the listen page shows one kind of message for any bad comment. This is also what
/// turns a stale client that still sends `name` or `website` into a clear error.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommentBody {
    body: String,
    at_step: i64,
}

fn too_many(throttled: Throttled) -> ApiError {
    ApiError::TooManyRequests {
        retry_after: throttled.retry_after_secs,
    }
}

async fn post_comment(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(token): Path<String>,
    // Extracted as a `Result` so the user's limit is charged before a malformed body can be
    // refused, which keeps invalid requests from probing for free.
    raw: Result<ApiJson<Value>, ApiError>,
) -> Result<Response, ApiError> {
    state
        .share_throttle
        .check_comment_user(&user.id)
        .map_err(too_many)?;
    let share = active_share(&state, &token).await?;
    if !share.allow_comments {
        return Err(ApiError::NotFound);
    }
    // Checked here and recorded only after the insert, so concurrent posts can overshoot by a few.
    // That is tolerated because the per-user limits and the 1,000-comment cap bound the excess,
    // and holding a lock across the database insert would cost more than it protects.
    state
        .share_throttle
        .check_comment_share(&share.id)
        .map_err(too_many)?;
    // Ahead of the username check so an oversized body is reported as such whoever sent it.
    if matches!(raw, Err(ApiError::PayloadTooLarge)) {
        return Err(ApiError::PayloadTooLarge);
    }
    let author_name = user.username.clone().ok_or(ApiError::UsernameRequired)?;

    let ApiJson(raw) = raw?;
    let body: CommentBody = serde_json::from_value(raw)
        .map_err(|_| invalid("The comment is missing a field or has an unexpected one."))?;
    let song = served_song(&share)?;

    let text = validated_body(&body.body)?;
    let at_step = validated_step(body.at_step, &song)?;
    let section = locate(&song, at_step);

    let new = NewComment {
        author_id: user.id,
        name: author_name,
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
    Ok((
        StatusCode::CREATED,
        Json(json!({"comment": {
            "id": stored.id,
            "name": new.name,
            "body": new.body,
            "at_step": new.at_step,
            "section_name": new.section_name,
            "created_at": stored.created_at,
        }})),
    )
        .into_response())
}

/// The body is deliberately not extracted: the copy comes only from the server's own copy of
/// the shared song, so nothing a client sends can reach it.
async fn remix(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(token): Path<String>,
) -> Result<Response, ApiError> {
    state
        .remix_limiter
        .try_record(&user.id, state.config.remixes_per_minute)
        .map_err(|retry_after| ApiError::TooManyRequests { retry_after })?;
    let share = active_share(&state, &token).await?;
    // The same answer as a dead token, so a response never reveals that remixing is the thing
    // that is off.
    if !share.allow_remix {
        return Err(ApiError::NotFound);
    }
    let song = remixed_song(share.song);
    let stored = create_project(&state, &user.id, song).await?;
    Ok((StatusCode::CREATED, Json(project_json(&stored)?)).into_response())
}

/// The projection drops section notes but `Song` requires the field, so it is restored empty
/// rather than copied: the owner's notes stay private.
fn remixed_song(mut song: Value) -> Value {
    if let Some(object) = song.as_object_mut() {
        if let Some(Value::Array(sections)) = object.get_mut("sections") {
            for section in sections.iter_mut().filter_map(Value::as_object_mut) {
                section
                    .entry("notes")
                    .or_insert_with(|| Value::String(String::new()));
            }
        }
        let name = remix_name(object.get("name").and_then(Value::as_str).unwrap_or(""));
        object.insert("name".into(), Value::String(name));
    }
    song
}

/// Lengths are UTF-16 units like song validation, so a name that fits here is accepted there.
fn remix_name(name: &str) -> String {
    let budget = SONG_NAME_MAX - REMIX_SUFFIX.encode_utf16().count();
    let mut used = 0;
    let mut kept = String::new();
    for c in name.chars() {
        used += c.len_utf16();
        if used > budget {
            break;
        }
        kept.push(c);
    }
    format!("{kept}{REMIX_SUFFIX}")
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

    #[test]
    fn remix_names_get_the_suffix_and_shorten_the_base_to_fit() {
        assert_eq!(remix_name("Late Train"), "Late Train (remix)");
        let name = remix_name(&"x".repeat(SONG_NAME_MAX));
        assert_eq!(name.encode_utf16().count(), SONG_NAME_MAX);
        assert!(name.ends_with(" (remix)"));
        let emoji = remix_name(&"\u{1F3B5}".repeat(SONG_NAME_MAX));
        assert!(emoji.encode_utf16().count() <= SONG_NAME_MAX);
        assert!(emoji.ends_with(" (remix)"));
    }
}
