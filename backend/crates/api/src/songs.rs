use axum::extract::State;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use music::song_midi::song_to_midi;
use music::{Song, SongError};

use crate::error::{ApiError, ApiJson};
use crate::patterns::slugify;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/songs/export/midi", post(export_midi))
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
