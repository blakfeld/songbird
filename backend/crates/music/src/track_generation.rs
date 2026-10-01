//! Request and response shapes for generating one track of a song. Validation
//! lives beside them so the HTTP layer only maps errors to status codes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instruments::InstrumentRegistry;
use crate::pattern::Note;
use crate::request::{validate_prompt, ValidationError};
use crate::song::{Song, SongError, ValidSong, MAX_MEASURES, MAX_TRACKS};

/// The most measures one generation call writes. Longer spans would grow the
/// prompt and the draft beyond what small local models handle reliably.
pub const MAX_RANGE_MEASURES: u32 = crate::expand::MAX_SPAN_MEASURES;

/// 1-based and inclusive, like the loop region and the measure numbers users see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct MeasureRange {
    pub start_measure: u32,
    pub end_measure: u32,
}

impl MeasureRange {
    pub fn measures(self) -> u32 {
        self.end_measure - self.start_measure + 1
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrackGenerateBody {
    pub song: Song,
    pub track_id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub range: Option<MeasureRange>,
}

/// `notes` count from the first step of `range`, so the browser can store them
/// unchanged as a loop that starts at the range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrackGenerateResponse {
    pub track_id: String,
    pub range: MeasureRange,
    pub notes: Vec<Note>,
}

/// Published so the Studio offers only choices the server will accept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SongLimits {
    pub max_input_tokens: u32,
    pub max_range_measures: u32,
    pub max_song_measures: u32,
    pub max_tracks: u32,
    pub max_chat_messages: u32,
}

impl SongLimits {
    pub fn new(max_input_tokens: u32) -> Self {
        Self {
            max_input_tokens,
            max_range_measures: MAX_RANGE_MEASURES,
            max_song_measures: MAX_MEASURES,
            max_tracks: MAX_TRACKS as u32,
            max_chat_messages: crate::chat::MAX_CHAT_MESSAGES as u32,
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TrackRequestError {
    #[error(transparent)]
    Song(#[from] SongError),
    #[error("The song has no track with that id.")]
    InvalidTrack,
    #[error(transparent)]
    Prompt(#[from] ValidationError),
    #[error("The range must lie within the song and span at most {MAX_RANGE_MEASURES} measures; a song longer than {MAX_RANGE_MEASURES} measures needs a range.")]
    InvalidRange,
}

impl TrackRequestError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Song(_) => "invalid_song",
            Self::InvalidTrack => "invalid_track",
            Self::Prompt(e) => e.code(),
            Self::InvalidRange => "invalid_range",
        }
    }
}

/// A request that passed every rule, so generation never re-checks them.
#[derive(Debug)]
pub struct ValidTrackRequest<'a> {
    pub song: ValidSong<'a>,
    pub target: usize,
    pub prompt: String,
    pub range: MeasureRange,
}

impl TrackGenerateBody {
    /// Ordered so the cheapest and most fundamental problems are reported
    /// first, and so no rejected request reaches a provider.
    pub fn validate(
        &self,
        instruments: &InstrumentRegistry,
        max_input_tokens: u32,
    ) -> Result<ValidTrackRequest<'_>, TrackRequestError> {
        let song = self.song.validate(instruments)?;
        let target = song
            .tracks
            .iter()
            .position(|t| t.track.id == self.track_id)
            .ok_or(TrackRequestError::InvalidTrack)?;
        let prompt = validate_prompt(&self.prompt, max_input_tokens)?;
        let range = resolve_range(self.range, self.song.measures)?;
        Ok(ValidTrackRequest {
            song,
            target,
            prompt,
            range,
        })
    }
}

fn resolve_range(
    requested: Option<MeasureRange>,
    song_measures: u32,
) -> Result<MeasureRange, TrackRequestError> {
    let range = match requested {
        Some(range) => range,
        None if song_measures <= MAX_RANGE_MEASURES => MeasureRange {
            start_measure: 1,
            end_measure: song_measures,
        },
        None => return Err(TrackRequestError::InvalidRange),
    };
    // Bounded by the song-length cap, not the current length, because a song's
    // length follows its clips and a new song is only one measure long.
    let ordered = range.start_measure >= 1 && range.start_measure <= range.end_measure;
    if !ordered || range.end_measure > MAX_MEASURES || range.measures() > MAX_RANGE_MEASURES {
        return Err(TrackRequestError::InvalidRange);
    }
    Ok(range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::song::tests::{song, track};

    fn body(measures: u32, range: Option<(u32, u32)>) -> TrackGenerateBody {
        TrackGenerateBody {
            song: song(
                measures,
                vec![track("d", "Drums", "drums"), track("b", "Bass", "bass")],
            ),
            track_id: "b".into(),
            prompt: "driving eighth-note bass".into(),
            range: range.map(|(start_measure, end_measure)| MeasureRange {
                start_measure,
                end_measure,
            }),
        }
    }

    fn outcome(body: &TrackGenerateBody) -> Result<(usize, MeasureRange), TrackRequestError> {
        body.validate(&InstrumentRegistry::builtin(), 256)
            .map(|v| (v.target, v.range))
    }

    fn code(body: &TrackGenerateBody) -> &'static str {
        outcome(body).unwrap_err().code()
    }

    #[test]
    fn a_short_song_defaults_to_the_whole_song() {
        let (target, range) = outcome(&body(8, None)).unwrap();
        assert_eq!(target, 1);
        assert_eq!((range.start_measure, range.end_measure), (1, 8));
        assert!(outcome(&body(32, None)).is_ok());
    }

    #[test]
    fn a_valid_range_is_kept() {
        let (_, range) = outcome(&body(16, Some((5, 8)))).unwrap();
        assert_eq!((range.start_measure, range.end_measure), (5, 8));
        assert!(outcome(&body(64, Some((1, 32)))).is_ok());
    }

    #[test]
    fn an_invalid_song_is_rejected_first() {
        let mut b = body(8, Some((7, 10)));
        b.track_id = "nope".into();
        b.song.tempo_bpm = 1000;
        assert_eq!(code(&b), "invalid_song");
    }

    #[test]
    fn an_unknown_track_is_rejected_before_the_prompt_and_range() {
        let mut b = body(8, Some((7, 10)));
        b.track_id = "nope".into();
        b.prompt = "  ".into();
        assert_eq!(code(&b), "invalid_track");
    }

    #[test]
    fn prompt_rules_match_pattern_generation() {
        let mut b = body(8, Some((7, 10)));
        b.prompt = "   ".into();
        assert_eq!(code(&b), "invalid_prompt");
        b.prompt = "a".repeat(1025);
        assert_eq!(code(&b), "prompt_too_long");
    }

    #[test]
    fn a_range_over_32_measures_is_rejected() {
        assert_eq!(code(&body(64, Some((1, 40)))), "invalid_range");
    }

    #[test]
    fn a_long_song_needs_a_range() {
        assert_eq!(code(&body(48, None)), "invalid_range");
    }

    #[test]
    fn a_range_may_extend_past_the_song_end_up_to_measure_128() {
        assert!(outcome(&body(8, Some((7, 10)))).is_ok());
        assert!(outcome(&body(1, Some((1, 16)))).is_ok());
        assert!(outcome(&body(8, Some((97, 128)))).is_ok());
        assert_eq!(code(&body(8, Some((120, 129)))), "invalid_range");
        assert_eq!(code(&body(8, Some((129, 130)))), "invalid_range");
    }

    #[test]
    fn reversed_and_zero_based_ranges_are_rejected() {
        assert_eq!(code(&body(8, Some((5, 4)))), "invalid_range");
        assert_eq!(code(&body(8, Some((0, 4)))), "invalid_range");
    }

    #[test]
    fn limits_reflect_the_song_caps() {
        let limits = SongLimits::new(128);
        assert_eq!(
            (
                limits.max_input_tokens,
                limits.max_range_measures,
                limits.max_song_measures,
                limits.max_tracks,
                limits.max_chat_messages
            ),
            (128, 32, 128, 16, 20)
        );
    }
}
