use axum::extract::State;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use music::ai::plan::{Plan, PlanRequest};
use music::chat::{
    plan_chat, render_planner_prompt, song_with_planned_track, track_limit_reached, ChatRange,
    LOOP_RANGE_REPLY, TRACK_LIMIT_REPLY,
};
use music::generate::generate_track;
use music::song_midi::song_to_midi;
use music::{
    ChatBody, ChatResponse, ChatTrack, Song, SongError, SongLimits, TrackGenerateBody,
    TrackGenerateResponse, ValidTrackRequest,
};

use crate::error::{ApiError, ApiJson};
use crate::patterns::{slugify, with_timeout};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/songs/export/midi", post(export_midi))
        .route("/api/v1/songs/tracks/generate", post(generate_track_part))
        .route("/api/v1/songs/limits", get(limits))
        .route("/api/v1/songs/chat", post(chat))
}

/// Two provider calls, each under its own timeout, because they fail
/// independently and a slow planner should not eat the generation's time.
async fn chat(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<ChatBody>,
) -> Result<Json<ChatResponse>, ApiError> {
    let chat = body.validate(&state.instruments, state.config.max_input_tokens)?;
    let timeout = state.config.generation_timeout;

    let plan_request = PlanRequest {
        user: render_planner_prompt(&chat, state.config.max_context_tokens),
        instruments: state.instruments.all().to_vec(),
        latest_user_message: chat.prompt.clone(),
    };
    let plan = with_timeout(
        timeout,
        plan_chat(state.providers.plans.as_ref(), &plan_request),
    )
    .await?;
    let (reply, instrument, track_name, prompt, measures) = match plan {
        Plan::ReplyOnly { reply } => return Ok(Json(ChatResponse::reply_only(reply))),
        Plan::AddTrack {
            reply,
            instrument,
            track_name,
            prompt,
            measures,
        } => (reply, instrument, track_name, prompt, measures),
    };

    // Enforced here whatever the planner decided, so a confused model cannot
    // push a song past its limits.
    if track_limit_reached(&chat.song) {
        return Ok(Json(ChatResponse::reply_only(TRACK_LIMIT_REPLY)));
    }
    let ChatRange::Range(range) = chat.range_for(measures) else {
        return Ok(Json(ChatResponse::reply_only(LOOP_RANGE_REPLY)));
    };

    let extended = song_with_planned_track(&body.song, &track_name, instrument.id);
    let valid = extended.validate(&state.instruments).map_err(|error| {
        tracing::error!(%error, "a validated song with one more track failed validation");
        ApiError::Internal
    })?;
    let request = ValidTrackRequest {
        target: valid.tracks.len() - 1,
        song: valid,
        prompt: cap_prompt(&prompt, state.config.max_input_tokens),
        range,
    };
    let generated = with_timeout(
        timeout,
        generate_track(
            state.providers.patterns.as_ref(),
            &request,
            state.config.max_context_tokens,
        ),
    )
    .await?;
    Ok(Json(ChatResponse {
        reply,
        track: Some(ChatTrack {
            name: track_name,
            instrument: instrument.id.to_string(),
            range,
            notes: generated.notes,
        }),
    }))
}

/// The planner is trusted to rewrite the prompt but not to respect the input
/// limit, and generation does not re-validate it.
fn cap_prompt(prompt: &str, max_input_tokens: u32) -> String {
    prompt.chars().take(max_input_tokens as usize * 4).collect()
}

async fn generate_track_part(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<TrackGenerateBody>,
) -> Result<Json<TrackGenerateResponse>, ApiError> {
    // Validation precedes the provider so rejected requests never cost tokens.
    let request = body.validate(&state.instruments, state.config.max_input_tokens)?;
    let response = with_timeout(
        state.config.generation_timeout,
        generate_track(
            state.providers.patterns.as_ref(),
            &request,
            state.config.max_context_tokens,
        ),
    )
    .await?;
    Ok(Json(response))
}

async fn limits(State(state): State<AppState>) -> Json<SongLimits> {
    Json(SongLimits::new(state.config.max_input_tokens))
}

async fn export_midi(
    State(state): State<AppState>,
    ApiJson(song): ApiJson<Song>,
) -> Result<Response, ApiError> {
    let valid = song
        .validate(&state.instruments)
        .map_err(|error| match error {
            SongError::UnknownInstrument { message } => ApiError::InvalidSongInstrument(message),
            SongError::Invalid { message, .. } => ApiError::InvalidSong(message),
        })?;
    let bytes = song_to_midi(&valid).map_err(|error| {
        tracing::error!(%error, "song MIDI serialization failed");
        ApiError::Internal
    })?;
    let disposition = format!(
        "attachment; filename=\"{}\"",
        song_filename(&song.name, song.tempo_bpm)
    );
    let disposition = HeaderValue::from_str(&disposition).expect("filename is ASCII");
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("audio/midi")),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    )
        .into_response())
}

fn song_filename(name: &str, tempo_bpm: u32) -> String {
    format!("songbird-{}-{tempo_bpm}bpm.mid", slugify(name, "song"))
}

#[cfg(test)]
mod tests {
    use super::song_filename;

    #[test]
    fn filename_is_slugged() {
        assert_eq!(
            song_filename("Late Train", 96),
            "songbird-late-train-96bpm.mid"
        );
        assert_eq!(song_filename("🚆", 96), "songbird-song-96bpm.mid");
    }
}
