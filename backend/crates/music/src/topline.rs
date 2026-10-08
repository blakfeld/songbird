//! Request and response shapes for generating a vocal melody (topline) over
//! one lyric section. Validation lives beside them so the HTTP layer only maps
//! errors to status codes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instruments::{Instrument, InstrumentKind, InstrumentRegistry, PitchRange};
use crate::pattern::Note;
use crate::request::{validate_prompt, ValidationError};
use crate::song::{validate_topline_lines, Song, SongError, ToplineLine, ValidSong, VoicePreset};
use crate::track_generation::{resolve_range, MeasureRange, TrackRequestError};

/// The spec requires an octave of overlap between voice and instrument: a
/// narrower range can lack a pitch class, so an out-of-range pitch could not
/// be folded back by whole octaves.
const MIN_VOICE_SPAN_SEMITONES: u8 = 12;

/// `range` is optional on the wire only so its absence is reported as
/// `invalid_range`, like track generation, instead of as malformed JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToplineGenerateBody {
    pub song: Song,
    pub track_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub range: Option<MeasureRange>,
    pub section_name: String,
    pub lines: Vec<ToplineLine>,
    pub voice: VoicePreset,
    /// Absent or empty both mean no style description.
    #[serde(default)]
    #[ts(as = "Option<String>", optional)]
    pub prompt: String,
}

/// Counts how many stressed syllables the melody put on a beat, so the Studio
/// can tell the user how well the stress rule was met.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Prosody {
    pub stressed_syllables: u32,
    pub stressed_on_beat: u32,
}

/// `notes` count from the first step of `range`, so the browser can store them
/// unchanged as a loop that starts at the range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToplineResponse {
    pub track_id: String,
    pub range: MeasureRange,
    pub notes: Vec<Note>,
    pub prosody: Prosody,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ToplineRequestError {
    #[error(transparent)]
    Song(#[from] SongError),
    #[error("The song has no track with that id.")]
    UnknownTrack,
    #[error("The track must be a melodic instrument track; drums, samplers and audio tracks cannot sing a topline.")]
    InvalidTrack,
    #[error("The range must lie within the song and span at most 32 measures.")]
    InvalidRange,
    #[error("The lyrics are not usable: {0}")]
    InvalidLyrics(String),
    #[error("The lyrics have {syllables} syllables but the range has room for only {steps}.")]
    LyricsDoNotFit { syllables: usize, steps: u32 },
    #[error("That voice does not span at least an octave on the chosen instrument.")]
    InvalidVoice,
    #[error(transparent)]
    Prompt(#[from] ValidationError),
}

impl ToplineRequestError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Song(_) => "invalid_song",
            Self::UnknownTrack | Self::InvalidTrack => "invalid_track",
            Self::InvalidRange => "invalid_range",
            Self::InvalidLyrics(_) => "invalid_lyrics",
            Self::LyricsDoNotFit { .. } => "lyrics_do_not_fit",
            Self::InvalidVoice => "invalid_voice",
            Self::Prompt(e) => e.code(),
        }
    }
}

#[derive(Debug)]
pub struct ValidToplineRequest<'a> {
    pub song: ValidSong<'a>,
    pub target: usize,
    pub instrument: &'static Instrument,
    pub range: MeasureRange,
    pub section_name: &'a str,
    pub lines: &'a [ToplineLine],
    pub voice: VoicePreset,
    pub prompt: String,
    /// The voice's range clipped to what the instrument can play.
    pub usable: PitchRange,
}

impl ToplineGenerateBody {
    /// Ordered so the cheapest and most fundamental problems are reported
    /// first, and so no rejected request reaches a provider.
    pub fn validate(
        &self,
        instruments: &InstrumentRegistry,
        max_input_tokens: u32,
    ) -> Result<ValidToplineRequest<'_>, ToplineRequestError> {
        let song = self.song.validate(instruments)?;
        let target = song
            .tracks
            .iter()
            .position(|t| t.track.id == self.track_id)
            .ok_or(ToplineRequestError::UnknownTrack)?;
        let instrument = song.tracks[target]
            .instrument
            .instrument()
            .filter(|i| i.kind == InstrumentKind::Melodic)
            .ok_or(ToplineRequestError::InvalidTrack)?;
        let range = self
            .range
            .ok_or(ToplineRequestError::InvalidRange)
            .and_then(|r| {
                resolve_range(Some(r), self.song.measures).map_err(|e| match e {
                    TrackRequestError::InvalidRange => ToplineRequestError::InvalidRange,
                    _ => unreachable!("range resolution only fails with InvalidRange"),
                })
            })?;
        validate_topline_lines(&self.section_name, &self.lines)
            .map_err(ToplineRequestError::InvalidLyrics)?;
        let syllables: usize = self.lines.iter().map(|l| l.syllables.len()).sum();
        let steps = range.measures() * self.song.steps_per_measure;
        if syllables > steps as usize {
            return Err(ToplineRequestError::LyricsDoNotFit { syllables, steps });
        }
        let usable = usable_range(self.voice, instrument)?;
        let prompt = if self.prompt.trim().is_empty() {
            String::new()
        } else {
            validate_prompt(&self.prompt, max_input_tokens)?
        };
        Ok(ValidToplineRequest {
            song,
            target,
            instrument,
            range,
            section_name: &self.section_name,
            lines: &self.lines,
            voice: self.voice,
            prompt,
            usable,
        })
    }
}

fn usable_range(
    voice: VoicePreset,
    instrument: &Instrument,
) -> Result<PitchRange, ToplineRequestError> {
    let (voice_low, voice_high) = voice.range();
    let range = instrument
        .range
        .expect("melodic instruments always have a range");
    let low = voice_low.max(range.low);
    let high = voice_high.min(range.high);
    if high < low || high - low < MIN_VOICE_SPAN_SEMITONES {
        return Err(ToplineRequestError::InvalidVoice);
    }
    Ok(PitchRange { low, high })
}

/// Pitch classes of the chord sounding at an absolute step, once sections can
/// carry chords. Isolated here so that change only has to fill in this one
/// function; until then the mock falls back to the tonic triad.
pub fn sounding_chord(_song: &ValidSong<'_>, _absolute_step: u32) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::song::tests::{clip, lp, song, track};
    use crate::song::ToplineSyllable;

    pub(crate) fn syllables(texts: &[(&str, bool)]) -> Vec<ToplineSyllable> {
        texts
            .iter()
            .map(|(text, stressed)| ToplineSyllable {
                text: (*text).into(),
                stressed: *stressed,
            })
            .collect()
    }

    pub(crate) fn line(text: &str, parts: &[(&str, bool)]) -> ToplineLine {
        ToplineLine {
            text: text.into(),
            syllables: syllables(parts),
        }
    }

    /// Two chorus lines, 14 syllables in all, over measures 5-8 of an 8-measure
    /// song with a Vocal Guide track.
    pub(crate) fn chorus_body() -> ToplineGenerateBody {
        let mut vocal = track("v", "Vocal", "vocal");
        vocal.loops = vec![lp("l1", 8, vec![])];
        vocal.clips = vec![clip("c1", "l1", 1, 8)];
        let mut drums = track("d", "Drums", "drums");
        drums.loops = vec![lp("l2", 8, vec![])];
        drums.clips = vec![clip("c2", "l2", 1, 8)];
        ToplineGenerateBody {
            song: song(8, vec![vocal, drums]),
            track_id: "v".into(),
            range: Some(MeasureRange {
                start_measure: 5,
                end_measure: 8,
            }),
            section_name: "Chorus".into(),
            lines: vec![
                line(
                    "Hold me close tonight",
                    &[
                        ("hold", true),
                        ("me", false),
                        ("close", true),
                        ("to-", false),
                        ("night", true),
                        ("oh", false),
                        ("yeah", true),
                    ],
                ),
                line(
                    "Never let me go away",
                    &[
                        ("nev-", true),
                        ("er", false),
                        ("let", false),
                        ("me", false),
                        ("go", true),
                        ("a-", false),
                        ("way", true),
                    ],
                ),
            ],
            voice: VoicePreset::Tenor,
            prompt: "soaring, mostly stepwise".into(),
        }
    }

    fn code(body: &ToplineGenerateBody) -> &'static str {
        body.validate(&InstrumentRegistry::builtin(), 256)
            .unwrap_err()
            .code()
    }

    #[test]
    fn a_valid_body_is_accepted_with_the_voice_clipped_to_the_instrument() {
        let body = chorus_body();
        let valid = body.validate(&InstrumentRegistry::builtin(), 256).unwrap();
        assert_eq!(valid.target, 0);
        assert_eq!((valid.usable.low, valid.usable.high), (48, 69));
    }

    #[test]
    fn an_empty_prompt_is_accepted() {
        let mut body = chorus_body();
        body.prompt = "  ".into();
        let valid = body.validate(&InstrumentRegistry::builtin(), 256).unwrap();
        assert_eq!(valid.prompt, "");
    }

    #[test]
    fn a_prompt_over_the_limit_is_too_long() {
        let mut body = chorus_body();
        body.prompt = "word ".repeat(2000);
        assert_eq!(code(&body), "prompt_too_long");
    }

    #[test]
    fn drums_and_unknown_tracks_are_invalid_tracks() {
        let mut body = chorus_body();
        body.track_id = "d".into();
        assert_eq!(code(&body), "invalid_track");
        body.track_id = "nope".into();
        assert_eq!(code(&body), "invalid_track");
    }

    #[test]
    fn audio_tracks_are_invalid_tracks() {
        let mut body = chorus_body();
        body.song.tracks[0].instrument = crate::song::AUDIO_INSTRUMENT_ID.into();
        body.song.tracks[0].loops.clear();
        body.song.tracks[0].clips.clear();
        assert_eq!(code(&body), "invalid_track");
    }

    #[test]
    fn a_missing_or_bad_range_is_invalid_range() {
        let mut body = chorus_body();
        body.range = None;
        assert_eq!(code(&body), "invalid_range");
        body.range = Some(MeasureRange {
            start_measure: 6,
            end_measure: 5,
        });
        assert_eq!(code(&body), "invalid_range");
    }

    #[test]
    fn bad_lines_are_invalid_lyrics() {
        let mut body = chorus_body();
        body.lines.clear();
        assert_eq!(code(&body), "invalid_lyrics");
        let mut body = chorus_body();
        body.section_name = String::new();
        assert_eq!(code(&body), "invalid_lyrics");
        let mut body = chorus_body();
        body.lines[0].syllables[0].text = "x".repeat(17);
        assert_eq!(code(&body), "invalid_lyrics");
    }

    #[test]
    fn seventeen_syllables_do_not_fit_one_measure() {
        let mut body = chorus_body();
        body.range = Some(MeasureRange {
            start_measure: 1,
            end_measure: 1,
        });
        body.lines = vec![line("la", &[("la", false); 17])];
        assert_eq!(code(&body), "lyrics_do_not_fit");
        body.lines = vec![line("la", &[("la", false); 16])];
        assert!(body.validate(&InstrumentRegistry::builtin(), 256).is_ok());
    }

    #[test]
    fn soprano_on_bass_is_an_invalid_voice() {
        let mut body = chorus_body();
        body.song.tracks[0].instrument = "bass".into();
        body.voice = VoicePreset::Soprano;
        assert_eq!(code(&body), "invalid_voice");
    }

    #[test]
    fn a_voice_overlapping_by_an_octave_is_accepted() {
        let mut body = chorus_body();
        body.song.tracks[0].instrument = "synth-lead".into();
        body.voice = VoicePreset::Baritone;
        let valid = body.validate(&InstrumentRegistry::builtin(), 256).unwrap();
        assert_eq!((valid.usable.low, valid.usable.high), (48, 65));
    }

    #[test]
    fn an_unknown_voice_does_not_deserialize() {
        let mut value = serde_json::to_value(chorus_body()).unwrap();
        value["voice"] = serde_json::json!("bass");
        assert!(serde_json::from_value::<ToplineGenerateBody>(value).is_err());
    }
}
