//! The song document is defined here once and generated into TypeScript, so the
//! browser, the export endpoint, and later features share one shape.

use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instruments::{Instrument, InstrumentKind, InstrumentRegistry};
use crate::meter::{TimeSignature, MAX_SWING, MAX_TEMPO_BPM, MIN_SWING, MIN_TEMPO_BPM};
use crate::pattern::Note;

pub const SONG_VERSION: u32 = 2;
pub const MAX_TRACKS: usize = 16;
pub const MIN_MEASURES: u32 = 1;
pub const MAX_MEASURES: u32 = 128;
pub const MIN_VOLUME_DB: f64 = -60.0;
pub const MAX_VOLUME_DB: f64 = 6.0;
pub const SONG_NAME_MAX: usize = 80;
pub const TRACK_NAME_MAX: usize = 40;
pub const LOOP_NAME_MAX: usize = 40;
pub const MAX_LOOPS: usize = 64;
pub const MAX_CLIPS: usize = 256;
/// Reserved so audio tracks need no extra field on `Track`; it is never in the
/// instrument registry, so older builds reject such songs instead of silently
/// dropping the audio.
pub const AUDIO_INSTRUMENT_ID: &str = "audio";
pub const MAX_SAMPLES: usize = 256;
pub const MAX_AUDIO_CLIPS: usize = 256;
pub const SAMPLE_NAME_MAX: usize = 80;
pub const MIN_SAMPLE_RATE: u32 = 22_050;
pub const MAX_SAMPLE_RATE: u32 = 192_000;
pub const MAX_SAMPLE_SECONDS: u32 = 20 * 60;
pub const MIN_CLIP_GAIN_DB: f64 = -24.0;
pub const MAX_CLIP_GAIN_DB: f64 = 12.0;
/// Four times finer than a step so clips keep sub-step placement while staying
/// on the musical grid across tempo changes.
pub const TICKS_PER_SIXTEENTH: u32 = 240;
/// A sixteenth is a quarter of a quarter note, so one second holds
/// `tempo_bpm / 60 * 4 * 240` ticks, which is `16 * tempo_bpm`.
const TICKS_PER_SECOND_PER_BPM: u128 = 16;

/// Snake_case and flat so the generated TypeScript matches the browser's
/// hand-written shape field for field.
///
/// Unknown fields are deliberately tolerated so later changes can add optional
/// fields without breaking older clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Song {
    #[ts(type = "2")]
    pub version: u32,
    pub id: String,
    pub name: String,
    pub tempo_bpm: u32,
    pub time_signature: TimeSignature,
    pub steps_per_measure: u32,
    pub swing: f64,
    /// Optional so songs saved before keys existed stay valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<SongKey>,
    /// Derived from the clips by the browser's `normalizeSong` and stored only
    /// so consumers read one number instead of scanning clips.
    pub measures: u32,
    /// The browser treats absent and `null` alike (no region, looping off), so
    /// `null` is accepted on input and normalised to absent on output. Declared
    /// nullable in TypeScript because stored documents may still hold `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub loop_region: Option<LoopRegion>,
    pub tracks: Vec<Track>,
    /// Metadata only: the audio itself lives in the browser and never enters
    /// the document, so the song stays small enough to post and export.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Sample>>", optional)]
    pub samples: Vec<Sample>,
    /// The Studio's song chat, saved with the song so it survives a reload.
    /// Optional so songs saved before the chat existed stay valid and songs
    /// without a conversation serialize as they always did.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<ChatEntry>>", optional)]
    pub chat: Vec<ChatEntry>,
}

/// The browser trims the saved conversation to this many entries.
pub const MAX_CHAT_ENTRIES: usize = 20;
/// Also the longest assistant message the chat endpoint accepts, so a saved
/// conversation can always be sent back.
pub const MAX_CHAT_CONTENT_CHARS: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ChatEntry {
    pub role: ChatRole,
    pub content: String,
    /// The track an assistant reply added, so the panel can label it and show
    /// when undo has removed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub track_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct SongKey {
    pub tonic: Tonic,
    pub mode: KeyMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub enum Tonic {
    C,
    #[serde(rename = "C#")]
    CSharp,
    D,
    #[serde(rename = "D#")]
    DSharp,
    E,
    F,
    #[serde(rename = "F#")]
    FSharp,
    G,
    #[serde(rename = "G#")]
    GSharp,
    A,
    #[serde(rename = "A#")]
    ASharp,
    B,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum KeyMode {
    Major,
    Minor,
}

impl SongKey {
    /// A song without a key reads as C major, matching what the Studio shows.
    pub const DEFAULT: SongKey = SongKey {
        tonic: Tonic::C,
        mode: KeyMode::Major,
    };

    pub fn name(self) -> String {
        let tonic = match self.tonic {
            Tonic::C => "C",
            Tonic::CSharp => "C#",
            Tonic::D => "D",
            Tonic::DSharp => "D#",
            Tonic::E => "E",
            Tonic::F => "F",
            Tonic::FSharp => "F#",
            Tonic::G => "G",
            Tonic::GSharp => "G#",
            Tonic::A => "A",
            Tonic::ASharp => "A#",
            Tonic::B => "B",
        };
        let mode = match self.mode {
            KeyMode::Major => "major",
            KeyMode::Minor => "minor",
        };
        format!("{tonic} {mode}")
    }
}

/// The flag sits beside the region because looping can be on with no region,
/// which loops the whole song.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct LoopRegion {
    pub region: Option<MeasureRegion>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct MeasureRegion {
    pub start_measure: u32,
    pub end_measure: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Track {
    pub id: String,
    pub name: String,
    pub instrument: String,
    pub volume_db: f64,
    pub pan: f64,
    pub muted: bool,
    pub soloed: bool,
    /// Both live on the track so a clip can never reference another
    /// instrument's loop.
    pub loops: Vec<Loop>,
    /// Kept sorted by `start_measure` so overlap and neighbour lookups stay
    /// linear; the browser's clip operations depend on it.
    pub clips: Vec<Clip>,
    /// Only audio tracks (instrument `audio`) hold these; they keep `loops` and
    /// `clips` empty so every existing reader of those fields stays correct.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<AudioClip>>", optional)]
    pub audio_clips: Vec<AudioClip>,
    /// Only overrides are stored, so an absent setting keeps following the
    /// instrument's preset and songs saved before track sound existed are
    /// unchanged. Unknown fields are ignored like the rest of the document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sound: Option<TrackSound>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct TrackSound {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tone: Option<Tone>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effects: Option<Effects>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Tone {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filter_cutoff_hz: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filter_resonance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attack_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decay_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sustain: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub release_s: Option<f64>,
    /// A float on the wire so a fractional value is reported as `sound` rather
    /// than failing deserialization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pitch_semitones: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Effects {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub eq: Option<EqEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub distortion: Option<DistortionEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chorus: Option<ChorusEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub delay: Option<DelayEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reverb: Option<ReverbEffect>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct EqEffect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub low_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mid_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub high_db: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct DistortionEffect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub drive: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mix: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ChorusEffect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rate_hz: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub depth: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mix: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct DelayEffect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    /// A string rather than an enum so a bad note value is reported as `sound`
    /// like every other bad setting, not as a deserialization failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"1/16\" | \"1/8\" | \"1/8d\" | \"1/4\" | \"1/2\"")]
    pub time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub feedback: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mix: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ReverbEffect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decay_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mix: Option<f64>,
}

/// Note steps count from the loop's own start so one loop can be placed at any
/// position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Loop {
    pub id: String,
    pub name: String,
    pub measures: u32,
    pub notes: Vec<Note>,
}

/// Whole-measure positions keep clips aligned with the loop region and
/// sections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Clip {
    pub id: String,
    pub loop_id: String,
    /// 1-based so it reads the same as the measure numbers users see.
    pub start_measure: u32,
    pub measures: u32,
}

/// Lengths are in the sample's own frames so they are exact and independent of
/// tempo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Sample {
    /// A content hash, so the same audio imported twice or opened from a bundle
    /// in another browser maps to one id.
    pub id: String,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u8,
    pub length_samples: u32,
    /// Open on purpose so later changes can add origins such as recordings
    /// without a document version bump; `"import"` is the only one so far.
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct AudioClip {
    pub id: String,
    pub sample_id: String,
    /// Song time at 240 ticks per sixteenth step; swing does not apply to audio.
    pub start_ticks: u32,
    pub offset_samples: u32,
    pub slice_samples: u32,
    pub length_samples: u32,
    /// Absent reads as false so a clip can be written without it.
    #[serde(default, rename = "loop")]
    pub looping: bool,
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub fade_in_samples: u32,
    #[serde(default)]
    pub fade_out_samples: u32,
}

/// Stable names that tests and the browser's shared fixture compare against;
/// the message text is free to change, these are not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SongErrorKind {
    Version,
    Name,
    Tempo,
    Swing,
    StepsPerMeasure,
    Measures,
    LoopRegion,
    Chat,
    TrackCount,
    TrackName,
    Volume,
    Pan,
    UnknownInstrument,
    LoopCount,
    ClipCount,
    DuplicateLoopId,
    LoopName,
    LoopLength,
    LoopNoteRow,
    LoopNoteRange,
    LoopNoteOverlap,
    DuplicateClipId,
    ClipLoop,
    ClipPosition,
    ClipLength,
    ClipOverlap,
    ClipOutsideSong,
    Sound,
    SampleCount,
    DuplicateSampleId,
    SampleName,
    SampleRate,
    SampleChannels,
    SampleLength,
    AudioTrackContent,
    AudioClipCount,
    AudioClipSample,
    AudioClipRange,
    AudioClipGain,
    AudioClipFade,
}

impl SongErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Version => "version",
            Self::Name => "name",
            Self::Tempo => "tempo",
            Self::Swing => "swing",
            Self::StepsPerMeasure => "steps_per_measure",
            Self::Measures => "measures",
            Self::LoopRegion => "loop_region",
            Self::Chat => "chat",
            Self::TrackCount => "track_count",
            Self::TrackName => "track_name",
            Self::Volume => "volume",
            Self::Pan => "pan",
            Self::UnknownInstrument => "unknown_instrument",
            Self::LoopCount => "loop_count",
            Self::ClipCount => "clip_count",
            Self::DuplicateLoopId => "duplicate_loop_id",
            Self::LoopName => "loop_name",
            Self::LoopLength => "loop_length",
            Self::LoopNoteRow => "loop_note_row",
            Self::LoopNoteRange => "loop_note_range",
            Self::LoopNoteOverlap => "loop_note_overlap",
            Self::DuplicateClipId => "duplicate_clip_id",
            Self::ClipLoop => "clip_loop",
            Self::ClipPosition => "clip_position",
            Self::ClipLength => "clip_length",
            Self::ClipOverlap => "clip_overlap",
            Self::ClipOutsideSong => "clip_outside_song",
            Self::Sound => "sound",
            Self::SampleCount => "sample_count",
            Self::DuplicateSampleId => "duplicate_sample_id",
            Self::SampleName => "sample_name",
            Self::SampleRate => "sample_rate",
            Self::SampleChannels => "sample_channels",
            Self::SampleLength => "sample_length",
            Self::AudioTrackContent => "audio_track_content",
            Self::AudioClipCount => "audio_clip_count",
            Self::AudioClipSample => "audio_clip_sample",
            Self::AudioClipRange => "audio_clip_range",
            Self::AudioClipGain => "audio_clip_gain",
            Self::AudioClipFade => "audio_clip_fade",
        }
    }
}

/// Messages name the offending track (and loop or clip) so the caller can show
/// them verbatim; they only describe the caller's own document.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SongError {
    /// Kept apart from `Invalid` because the API reports it under its own code,
    /// the same one the pattern endpoints use for unknown instruments.
    #[error("{message}")]
    UnknownInstrument { message: String },
    #[error("{message}")]
    Invalid {
        kind: SongErrorKind,
        message: String,
    },
}

impl SongError {
    pub fn kind(&self) -> SongErrorKind {
        match self {
            Self::UnknownInstrument { .. } => SongErrorKind::UnknownInstrument,
            Self::Invalid { kind, .. } => *kind,
        }
    }
}

fn invalid(kind: SongErrorKind, message: impl Into<String>) -> SongError {
    SongError::Invalid {
        kind,
        message: message.into(),
    }
}

/// A song that passed `Song::validate`, with everything export and generation
/// would otherwise re-derive: each track's instrument and flattened notes.
#[derive(Debug)]
pub struct ValidSong<'a> {
    pub song: &'a Song,
    pub tracks: Vec<ValidTrack<'a>>,
}

#[derive(Debug)]
pub struct ValidTrack<'a> {
    pub track: &'a Track,
    pub instrument: TrackInstrument,
    /// Sorted by step so export and generation can stream them in time order.
    /// Always empty for audio tracks.
    pub notes: Vec<Note>,
}

/// Audio tracks have no registry entry, so consumers must decide explicitly what
/// to do with them instead of dereferencing an instrument that is not there.
#[derive(Debug, Clone, Copy)]
pub enum TrackInstrument {
    Instrument(&'static Instrument),
    Audio,
}

impl TrackInstrument {
    pub fn instrument(self) -> Option<&'static Instrument> {
        match self {
            Self::Instrument(instrument) => Some(instrument),
            Self::Audio => None,
        }
    }
}

impl ValidTrack<'_> {
    pub fn is_audio(&self) -> bool {
        matches!(self.instrument, TrackInstrument::Audio)
    }
}

/// The browser measures names in UTF-16 units, so counting the same way keeps
/// the two validators agreeing on names with emoji.
fn name_len(name: &str) -> usize {
    name.encode_utf16().count()
}

fn track_label(index: usize, track: &Track) -> String {
    format!("track {} \"{}\"", index + 1, track.name)
}

impl Song {
    pub fn total_steps(&self) -> u32 {
        self.measures.saturating_mul(self.steps_per_measure)
    }

    /// Checks run in the same order as the browser's `validateClips`, so a
    /// document with several problems reports the same one on both sides.
    pub fn validate(&self, registry: &InstrumentRegistry) -> Result<ValidSong<'_>, SongError> {
        self.validate_header()?;
        if self.tracks.len() > MAX_TRACKS {
            return Err(invalid(
                SongErrorKind::TrackCount,
                format!(
                    "a song has at most {MAX_TRACKS} tracks, got {}",
                    self.tracks.len()
                ),
            ));
        }

        let samples = self.validate_samples()?;

        let mut loop_ids = HashSet::new();
        let mut clip_ids = HashSet::new();
        let mut tracks = Vec::with_capacity(self.tracks.len());
        for (index, track) in self.tracks.iter().enumerate() {
            let instrument = self.validate_track(
                index,
                track,
                registry,
                &samples,
                &mut loop_ids,
                &mut clip_ids,
            )?;
            tracks.push(ValidTrack {
                track,
                instrument,
                notes: resolve_track_notes(track, self.steps_per_measure),
            });
        }
        Ok(ValidSong { song: self, tracks })
    }

    fn validate_header(&self) -> Result<(), SongError> {
        if self.version != SONG_VERSION {
            return Err(invalid(
                SongErrorKind::Version,
                format!("song version must be {SONG_VERSION}, got {}", self.version),
            ));
        }
        if name_len(&self.name) > SONG_NAME_MAX {
            return Err(invalid(
                SongErrorKind::Name,
                format!("song name must be at most {SONG_NAME_MAX} characters"),
            ));
        }
        if !(MIN_TEMPO_BPM..=MAX_TEMPO_BPM).contains(&self.tempo_bpm) {
            return Err(invalid(
                SongErrorKind::Tempo,
                format!(
                    "tempo_bpm must be {MIN_TEMPO_BPM}-{MAX_TEMPO_BPM}, got {}",
                    self.tempo_bpm
                ),
            ));
        }
        if !(MIN_SWING..=MAX_SWING).contains(&self.swing) {
            return Err(invalid(
                SongErrorKind::Swing,
                format!("swing must be {MIN_SWING}-{MAX_SWING}, got {}", self.swing),
            ));
        }
        let expected_steps = self.time_signature.steps_per_measure();
        if self.steps_per_measure != expected_steps {
            return Err(invalid(
                SongErrorKind::StepsPerMeasure,
                format!(
                    "steps_per_measure must be {expected_steps} for {}, got {}",
                    self.time_signature.as_str(),
                    self.steps_per_measure
                ),
            ));
        }
        if !(MIN_MEASURES..=MAX_MEASURES).contains(&self.measures) {
            return Err(invalid(
                SongErrorKind::Measures,
                format!(
                    "measures must be {MIN_MEASURES}-{MAX_MEASURES}, got {}",
                    self.measures
                ),
            ));
        }
        if let Some(region) = self.loop_region.and_then(|l| l.region) {
            let (start, end) = (region.start_measure, region.end_measure);
            if start < 1 || end < start || end > MAX_MEASURES {
                return Err(invalid(
                    SongErrorKind::LoopRegion,
                    format!(
                        "loop region must satisfy 1 <= start <= end <= {MAX_MEASURES}, got {start}-{end}"
                    ),
                ));
            }
        }
        if self.chat.len() > MAX_CHAT_ENTRIES
            || self
                .chat
                .iter()
                .any(|e| e.content.chars().count() > MAX_CHAT_CONTENT_CHARS)
        {
            return Err(invalid(
                SongErrorKind::Chat,
                format!(
                    "chat holds at most {MAX_CHAT_ENTRIES} messages of {MAX_CHAT_CONTENT_CHARS} characters"
                ),
            ));
        }
        Ok(())
    }

    fn validate_samples(&self) -> Result<HashMap<&str, &Sample>, SongError> {
        if self.samples.len() > MAX_SAMPLES {
            return Err(invalid(
                SongErrorKind::SampleCount,
                format!(
                    "samples: at most {MAX_SAMPLES} samples, got {}",
                    self.samples.len()
                ),
            ));
        }
        let mut by_id = HashMap::new();
        for sample in &self.samples {
            let label = format!("samples: sample `{}`", sample.id);
            if by_id.insert(sample.id.as_str(), sample).is_some() {
                return Err(invalid(
                    SongErrorKind::DuplicateSampleId,
                    format!("{label} is used more than once"),
                ));
            }
            if sample.name.is_empty() || name_len(&sample.name) > SAMPLE_NAME_MAX {
                return Err(invalid(
                    SongErrorKind::SampleName,
                    format!("{label}: name must be 1-{SAMPLE_NAME_MAX} characters"),
                ));
            }
            if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample.sample_rate) {
                return Err(invalid(
                    SongErrorKind::SampleRate,
                    format!(
                        "{label}: sample_rate must be {MIN_SAMPLE_RATE}-{MAX_SAMPLE_RATE}, got {}",
                        sample.sample_rate
                    ),
                ));
            }
            if !(1..=2).contains(&sample.channels) {
                return Err(invalid(
                    SongErrorKind::SampleChannels,
                    format!("{label}: channels must be 1 or 2, got {}", sample.channels),
                ));
            }
            let max_length = u64::from(sample.sample_rate) * u64::from(MAX_SAMPLE_SECONDS);
            if sample.length_samples < 1 || u64::from(sample.length_samples) > max_length {
                return Err(invalid(
                    SongErrorKind::SampleLength,
                    format!(
                        "{label}: length_samples must be 1-{max_length} (20 minutes), got {}",
                        sample.length_samples
                    ),
                ));
            }
        }
        Ok(by_id)
    }

    fn validate_track(
        &self,
        index: usize,
        track: &Track,
        registry: &InstrumentRegistry,
        samples: &HashMap<&str, &Sample>,
        loop_ids: &mut HashSet<String>,
        clip_ids: &mut HashSet<String>,
    ) -> Result<TrackInstrument, SongError> {
        let label = track_label(index, track);
        if name_len(&track.name) > TRACK_NAME_MAX {
            return Err(invalid(
                SongErrorKind::TrackName,
                format!("{label}: name must be at most {TRACK_NAME_MAX} characters"),
            ));
        }
        if !(MIN_VOLUME_DB..=MAX_VOLUME_DB).contains(&track.volume_db) {
            return Err(invalid(
                SongErrorKind::Volume,
                format!(
                    "{label}: volume_db must be {MIN_VOLUME_DB}-{MAX_VOLUME_DB}, got {}",
                    track.volume_db
                ),
            ));
        }
        if !(-1.0..=1.0).contains(&track.pan) {
            return Err(invalid(
                SongErrorKind::Pan,
                format!("{label}: pan must be -1 to 1, got {}", track.pan),
            ));
        }
        if track.instrument == AUDIO_INSTRUMENT_ID {
            self.validate_audio_track(&label, track, samples, clip_ids)?;
            return Ok(TrackInstrument::Audio);
        }
        let instrument =
            registry
                .get(&track.instrument)
                .ok_or_else(|| SongError::UnknownInstrument {
                    message: format!("{label}: unknown instrument `{}`", track.instrument),
                })?;
        if !track.audio_clips.is_empty() {
            return Err(invalid(
                SongErrorKind::AudioTrackContent,
                format!("{label}: audio clips belong on audio tracks only"),
            ));
        }
        if track.loops.len() > MAX_LOOPS {
            return Err(invalid(
                SongErrorKind::LoopCount,
                format!(
                    "{label}: at most {MAX_LOOPS} loops, got {}",
                    track.loops.len()
                ),
            ));
        }
        if track.clips.len() > MAX_CLIPS {
            return Err(invalid(
                SongErrorKind::ClipCount,
                format!(
                    "{label}: at most {MAX_CLIPS} clips, got {}",
                    track.clips.len()
                ),
            ));
        }

        let mut own_loops = HashSet::new();
        for lp in &track.loops {
            if !loop_ids.insert(lp.id.clone()) {
                return Err(invalid(
                    SongErrorKind::DuplicateLoopId,
                    format!("{label}: loop id `{}` is used more than once", lp.id),
                ));
            }
            self.validate_loop(&label, lp, instrument)?;
            own_loops.insert(lp.id.as_str());
        }

        for clip in &track.clips {
            if !clip_ids.insert(clip.id.clone()) {
                return Err(invalid(
                    SongErrorKind::DuplicateClipId,
                    format!("{label}: clip id `{}` is used more than once", clip.id),
                ));
            }
            if !own_loops.contains(clip.loop_id.as_str()) {
                return Err(invalid(
                    SongErrorKind::ClipLoop,
                    format!(
                        "{label}: clip `{}` names loop `{}`, which is not a loop of this track",
                        clip.id, clip.loop_id
                    ),
                ));
            }
            if clip.start_measure < 1 {
                return Err(invalid(
                    SongErrorKind::ClipPosition,
                    format!(
                        "{label}: clip `{}` must start at measure 1 or later",
                        clip.id
                    ),
                ));
            }
            if clip.measures < 1 {
                return Err(invalid(
                    SongErrorKind::ClipLength,
                    format!("{label}: clip `{}` must be at least 1 measure", clip.id),
                ));
            }
        }

        let mut ordered: Vec<&Clip> = track.clips.iter().collect();
        ordered.sort_by_key(|c| c.start_measure);
        let mut previous_end = 1u64;
        for clip in ordered {
            let start = u64::from(clip.start_measure);
            if start < previous_end {
                return Err(invalid(
                    SongErrorKind::ClipOverlap,
                    format!("{label}: clip `{}` overlaps the clip before it", clip.id),
                ));
            }
            previous_end = start + u64::from(clip.measures);
            if previous_end > u64::from(self.measures) + 1 {
                return Err(invalid(
                    SongErrorKind::ClipOutsideSong,
                    format!(
                        "{label}: clip `{}` ends after the song's {} measures",
                        clip.id, self.measures
                    ),
                ));
            }
        }
        if let Some(sound) = &track.sound {
            validate_sound(&label, sound, instrument)?;
        }
        Ok(TrackInstrument::Instrument(instrument))
    }

    fn validate_audio_track(
        &self,
        label: &str,
        track: &Track,
        samples: &HashMap<&str, &Sample>,
        clip_ids: &mut HashSet<String>,
    ) -> Result<(), SongError> {
        if !track.loops.is_empty() || !track.clips.is_empty() {
            return Err(invalid(
                SongErrorKind::AudioTrackContent,
                format!("{label}: an audio track holds audio clips, not loops or clips"),
            ));
        }
        if track.audio_clips.len() > MAX_AUDIO_CLIPS {
            return Err(invalid(
                SongErrorKind::AudioClipCount,
                format!(
                    "{label}: at most {MAX_AUDIO_CLIPS} audio clips, got {}",
                    track.audio_clips.len()
                ),
            ));
        }
        for clip in &track.audio_clips {
            if !clip_ids.insert(clip.id.clone()) {
                return Err(invalid(
                    SongErrorKind::DuplicateClipId,
                    format!("{label}: clip id `{}` is used more than once", clip.id),
                ));
            }
            let sample = samples.get(clip.sample_id.as_str()).ok_or_else(|| {
                invalid(
                    SongErrorKind::AudioClipSample,
                    format!(
                        "{label}: clip `{}` names sample `{}`, which is not in samples",
                        clip.id, clip.sample_id
                    ),
                )
            })?;
            validate_audio_clip_fields(label, clip, sample)?;
            self.check_audio_clip_within_song(label, clip, sample)?;
        }

        let mut ordered: Vec<&AudioClip> = track.audio_clips.iter().collect();
        ordered.sort_by_key(|c| c.start_ticks);
        for pair in ordered.windows(2) {
            // Sorted, so only a neighbour can overlap; the sample is known to
            // exist from the loop above.
            let sample = samples[pair[0].sample_id.as_str()];
            let gap_ticks = u128::from(pair[1].start_ticks - pair[0].start_ticks);
            let clip_ticks_times_rate = u128::from(pair[0].length_samples)
                * TICKS_PER_SECOND_PER_BPM
                * u128::from(self.tempo_bpm);
            if clip_ticks_times_rate > gap_ticks * u128::from(sample.sample_rate) {
                return Err(invalid(
                    SongErrorKind::ClipOverlap,
                    format!(
                        "{label}: clip `{}` overlaps the clip before it at {} BPM",
                        pair[1].id, self.tempo_bpm
                    ),
                ));
            }
        }

        if let Some(sound) = &track.sound {
            if let Some(tone) = &sound.tone {
                return Err(invalid(
                    SongErrorKind::Sound,
                    format!(
                        "{label}: {} applies to instrument tracks, not audio tracks",
                        first_tone_field(tone)
                    ),
                ));
            }
            if let Some(effects) = &sound.effects {
                validate_effects(label, effects)?;
            }
        }
        Ok(())
    }

    /// Integer arithmetic on the clip's end in ticks scaled by the sample rate,
    /// so no float rounding can make the browser and server disagree at a
    /// measure boundary.
    fn check_audio_clip_within_song(
        &self,
        label: &str,
        clip: &AudioClip,
        sample: &Sample,
    ) -> Result<(), SongError> {
        let rate = u128::from(sample.sample_rate);
        let end = u128::from(clip.start_ticks) * rate
            + u128::from(clip.length_samples)
                * TICKS_PER_SECOND_PER_BPM
                * u128::from(self.tempo_bpm);
        let song_end = u128::from(self.measures)
            * u128::from(self.steps_per_measure)
            * u128::from(TICKS_PER_SIXTEENTH)
            * rate;
        if end > song_end {
            return Err(invalid(
                SongErrorKind::ClipOutsideSong,
                format!(
                    "{label}: clip `{}` ends after the song's {} measures at {} BPM (the limit is {MAX_MEASURES})",
                    clip.id, self.measures, self.tempo_bpm
                ),
            ));
        }
        Ok(())
    }

    fn validate_loop(
        &self,
        label: &str,
        lp: &Loop,
        instrument: &Instrument,
    ) -> Result<(), SongError> {
        if lp.name.is_empty() || name_len(&lp.name) > LOOP_NAME_MAX {
            return Err(invalid(
                SongErrorKind::LoopName,
                format!("{label}: loop names must be 1-{LOOP_NAME_MAX} characters"),
            ));
        }
        if !(MIN_MEASURES..=MAX_MEASURES).contains(&lp.measures) {
            return Err(invalid(
                SongErrorKind::LoopLength,
                format!(
                    "{label}: loop `{}` must be {MIN_MEASURES}-{MAX_MEASURES} measures, got {}",
                    lp.name, lp.measures
                ),
            ));
        }
        let total_steps = u64::from(lp.measures) * u64::from(self.steps_per_measure);
        let mut spans_by_row: HashMap<&str, Vec<(u64, u64)>> = HashMap::new();
        for note in &lp.notes {
            if instrument.row_index(&note.row_id).is_none() {
                return Err(invalid(
                    SongErrorKind::LoopNoteRow,
                    format!(
                        "{label}: loop `{}` has a note on row `{}`, which {} does not have",
                        lp.name, note.row_id, instrument.name
                    ),
                ));
            }
            let start = u64::from(note.step);
            let end = start + u64::from(note.length_steps);
            if note.length_steps < 1 || end > total_steps || !(1..=127).contains(&note.velocity) {
                return Err(invalid(
                    SongErrorKind::LoopNoteRange,
                    format!(
                        "{label}: loop `{}` has a note on `{}` at step {} outside the loop or with an invalid length or velocity",
                        lp.name, note.row_id, note.step
                    ),
                ));
            }
            spans_by_row
                .entry(note.row_id.as_str())
                .or_default()
                .push((start, end));
        }
        for (row, mut spans) in spans_by_row {
            spans.sort_unstable();
            if spans.windows(2).any(|pair| pair[1].0 < pair[0].1) {
                return Err(invalid(
                    SongErrorKind::LoopNoteOverlap,
                    format!(
                        "{label}: loop `{}` has overlapping notes on row `{row}`",
                        lp.name
                    ),
                ));
            }
        }
        Ok(())
    }
}

/// Mirrored by the browser's range table; the shared validation fixture keeps
/// the two in step.
pub const DELAY_TIMES: [&str; 5] = ["1/16", "1/8", "1/8d", "1/4", "1/2"];

struct SoundCheck<'a> {
    label: &'a str,
}

impl SoundCheck<'_> {
    fn range(&self, name: &str, value: Option<f64>, min: f64, max: f64) -> Result<(), SongError> {
        match value {
            Some(v) if !(min..=max).contains(&v) => Err(invalid(
                SongErrorKind::Sound,
                format!("{}: {name} must be {min}-{max}, got {v}", self.label),
            )),
            _ => Ok(()),
        }
    }

    fn only_for(
        &self,
        name: &str,
        value: Option<f64>,
        allowed: bool,
        kind_name: &str,
    ) -> Result<(), SongError> {
        if value.is_some() && !allowed {
            return Err(invalid(
                SongErrorKind::Sound,
                format!("{}: {name} applies to {kind_name} tracks only", self.label),
            ));
        }
        Ok(())
    }
}

fn validate_sound(
    label: &str,
    sound: &TrackSound,
    instrument: &Instrument,
) -> Result<(), SongError> {
    let check = SoundCheck { label };
    let melodic = instrument.kind == InstrumentKind::Melodic;
    let drums = instrument.kind == InstrumentKind::Drums;

    if let Some(tone) = &sound.tone {
        check.only_for("attack_s", tone.attack_s, melodic, "melodic")?;
        check.only_for("decay_s", tone.decay_s, melodic, "melodic")?;
        check.only_for("sustain", tone.sustain, melodic, "melodic")?;
        check.only_for("release_s", tone.release_s, melodic, "melodic")?;
        check.only_for("pitch_semitones", tone.pitch_semitones, drums, "drums")?;
        check.range("filter_cutoff_hz", tone.filter_cutoff_hz, 40.0, 20000.0)?;
        check.range("filter_resonance", tone.filter_resonance, 0.0, 1.0)?;
        check.range("attack_s", tone.attack_s, 0.001, 2.0)?;
        check.range("decay_s", tone.decay_s, 0.01, 4.0)?;
        check.range("sustain", tone.sustain, 0.0, 1.0)?;
        check.range("release_s", tone.release_s, 0.01, 8.0)?;
        check.range("pitch_semitones", tone.pitch_semitones, -12.0, 12.0)?;
        if tone.pitch_semitones.is_some_and(|v| v.fract() != 0.0) {
            return Err(invalid(
                SongErrorKind::Sound,
                format!("{label}: pitch_semitones must be a whole number"),
            ));
        }
    }

    match &sound.effects {
        Some(effects) => validate_effects(label, effects),
        None => Ok(()),
    }
}

fn validate_effects(label: &str, effects: &Effects) -> Result<(), SongError> {
    let check = SoundCheck { label };
    if let Some(eq) = &effects.eq {
        check.range("low_db", eq.low_db, -12.0, 12.0)?;
        check.range("mid_db", eq.mid_db, -12.0, 12.0)?;
        check.range("high_db", eq.high_db, -12.0, 12.0)?;
    }
    if let Some(distortion) = &effects.distortion {
        check.range("drive", distortion.drive, 0.0, 1.0)?;
        check.range("mix", distortion.mix, 0.0, 1.0)?;
    }
    if let Some(chorus) = &effects.chorus {
        check.range("rate_hz", chorus.rate_hz, 0.1, 8.0)?;
        check.range("depth", chorus.depth, 0.0, 1.0)?;
        check.range("mix", chorus.mix, 0.0, 1.0)?;
    }
    if let Some(delay) = &effects.delay {
        if let Some(time) = &delay.time {
            if !DELAY_TIMES.contains(&time.as_str()) {
                return Err(invalid(
                    SongErrorKind::Sound,
                    format!(
                        "{label}: delay time must be one of {}, got \"{time}\"",
                        DELAY_TIMES.join(", ")
                    ),
                ));
            }
        }
        check.range("feedback", delay.feedback, 0.0, 0.9)?;
        check.range("mix", delay.mix, 0.0, 1.0)?;
    }
    if let Some(reverb) = &effects.reverb {
        check.range("decay_s", reverb.decay_s, 0.5, 10.0)?;
        check.range("mix", reverb.mix, 0.0, 1.0)?;
    }
    Ok(())
}

fn validate_audio_clip_fields(
    label: &str,
    clip: &AudioClip,
    sample: &Sample,
) -> Result<(), SongError> {
    let range_error = |detail: String| {
        invalid(
            SongErrorKind::AudioClipRange,
            format!("{label}: clip `{}` {detail}", clip.id),
        )
    };
    if clip.slice_samples < 1 {
        return Err(range_error("must use at least 1 sample".into()));
    }
    if u64::from(clip.offset_samples) + u64::from(clip.slice_samples)
        > u64::from(sample.length_samples)
    {
        return Err(range_error(format!(
            "uses samples {}-{}, past the end of its sample ({} samples)",
            clip.offset_samples,
            u64::from(clip.offset_samples) + u64::from(clip.slice_samples),
            sample.length_samples
        )));
    }
    if clip.length_samples < 1 {
        return Err(range_error("must play at least 1 sample".into()));
    }
    if !clip.looping && clip.length_samples > clip.slice_samples {
        return Err(range_error(
            "is longer than its slice, which only a looping clip may be".into(),
        ));
    }
    if !(MIN_CLIP_GAIN_DB..=MAX_CLIP_GAIN_DB).contains(&clip.gain_db) {
        return Err(invalid(
            SongErrorKind::AudioClipGain,
            format!(
                "{label}: clip `{}` gain_db must be {MIN_CLIP_GAIN_DB}-{MAX_CLIP_GAIN_DB}, got {}",
                clip.id, clip.gain_db
            ),
        ));
    }
    if u64::from(clip.fade_in_samples) + u64::from(clip.fade_out_samples)
        > u64::from(clip.length_samples)
    {
        return Err(invalid(
            SongErrorKind::AudioClipFade,
            format!("{label}: clip `{}` fades are longer than the clip", clip.id),
        ));
    }
    Ok(())
}

fn first_tone_field(tone: &Tone) -> &'static str {
    let set = [
        ("filter_cutoff_hz", tone.filter_cutoff_hz.is_some()),
        ("filter_resonance", tone.filter_resonance.is_some()),
        ("attack_s", tone.attack_s.is_some()),
        ("decay_s", tone.decay_s.is_some()),
        ("sustain", tone.sustain.is_some()),
        ("release_s", tone.release_s.is_some()),
        ("pitch_semitones", tone.pitch_semitones.is_some()),
    ];
    set.into_iter()
        .find_map(|(name, present)| present.then_some(name))
        .unwrap_or("tone")
}

/// A port of the browser's `resolveTrackNotes`, which is what the Studio
/// plays; the shared `fixtures/clip_resolution.json` keeps the two in step.
/// Intended for validated tracks: arithmetic saturates rather than panics so a
/// hostile document can never abort the process.
pub fn resolve_track_notes(track: &Track, steps_per_measure: u32) -> Vec<Note> {
    let mut out = Vec::new();
    for clip in &track.clips {
        let Some(lp) = track.loops.iter().find(|l| l.id == clip.loop_id) else {
            continue;
        };
        let loop_steps = lp.measures.saturating_mul(steps_per_measure);
        if loop_steps == 0 {
            continue;
        }
        let clip_steps = clip.measures.saturating_mul(steps_per_measure);
        let base = clip
            .start_measure
            .saturating_sub(1)
            .saturating_mul(steps_per_measure);
        for offset in (0..clip_steps).step_by(loop_steps as usize) {
            for note in &lp.notes {
                let local = offset.saturating_add(note.step);
                if local >= clip_steps {
                    continue;
                }
                out.push(Note {
                    step: base.saturating_add(local),
                    length_steps: note.length_steps.min(clip_steps - local),
                    ..note.clone()
                });
            }
        }
    }
    out.sort_by_key(|n| n.step);
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{json, Value};

    pub(crate) fn note(row: &str, step: u32, length: u32) -> Note {
        Note {
            row_id: row.into(),
            step,
            length_steps: length,
            velocity: 100,
        }
    }

    pub(crate) fn track(id: &str, name: &str, instrument: &str) -> Track {
        Track {
            id: id.into(),
            name: name.into(),
            instrument: instrument.into(),
            volume_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            loops: vec![],
            clips: vec![],
            audio_clips: vec![],
            sound: None,
        }
    }

    pub(crate) fn lp(id: &str, measures: u32, notes: Vec<Note>) -> Loop {
        Loop {
            id: id.into(),
            name: format!("Loop {id}"),
            measures,
            notes,
        }
    }

    pub(crate) fn clip(id: &str, loop_id: &str, start: u32, measures: u32) -> Clip {
        Clip {
            id: id.into(),
            loop_id: loop_id.into(),
            start_measure: start,
            measures,
        }
    }

    pub(crate) fn song(measures: u32, tracks: Vec<Track>) -> Song {
        Song {
            version: 2,
            id: "song".into(),
            name: "Late Train".into(),
            tempo_bpm: 96,
            time_signature: TimeSignature::FourFour,
            steps_per_measure: 16,
            swing: 0.0,
            key: None,
            measures,
            loop_region: None,
            tracks,
            samples: vec![],
            chat: vec![],
        }
    }

    /// Drums with a kick loop in measures 1-4 and a piano with a chord loop.
    pub(crate) fn two_track_song() -> Song {
        let mut drums = track("t1", "Drums", "drums");
        drums.loops = vec![lp("l1", 1, vec![note("kick", 0, 1)])];
        drums.clips = vec![clip("c1", "l1", 1, 4)];
        let mut piano = track("t2", "Piano", "piano");
        piano.loops = vec![lp("l2", 2, vec![note("C4", 0, 4)])];
        piano.clips = vec![clip("c2", "l2", 1, 2)];
        song(4, vec![drums, piano])
    }

    fn error_kind(song: &Song) -> &'static str {
        song.validate(&InstrumentRegistry::builtin())
            .unwrap_err()
            .kind()
            .as_str()
    }

    fn rejected(edit: impl FnOnce(&mut Song)) -> SongError {
        let mut s = two_track_song();
        edit(&mut s);
        s.validate(&InstrumentRegistry::builtin()).unwrap_err()
    }

    #[test]
    fn valid_two_track_song_resolves_instruments_and_notes() {
        let s = two_track_song();
        let valid = s.validate(&InstrumentRegistry::builtin()).unwrap();
        assert_eq!(valid.tracks.len(), 2);
        assert_eq!(valid.tracks[0].instrument.instrument().unwrap().id, "drums");
        let kicks: Vec<u32> = valid.tracks[0].notes.iter().map(|n| n.step).collect();
        assert_eq!(kicks, vec![0, 16, 32, 48]);
        assert_eq!(valid.tracks[1].notes.len(), 1);
    }

    type Edit = Box<dyn FnOnce(&mut Song)>;

    #[test]
    fn each_rule_is_rejected_with_its_kind() {
        let cases: Vec<(&str, Edit)> = vec![
            ("version", Box::new(|s| s.version = 1)),
            ("name", Box::new(|s| s.name = "x".repeat(81))),
            ("tempo", Box::new(|s| s.tempo_bpm = 241)),
            ("swing", Box::new(|s| s.swing = 0.8)),
            ("steps_per_measure", Box::new(|s| s.steps_per_measure = 12)),
            ("measures", Box::new(|s| s.measures = 0)),
            ("measures", Box::new(|s| s.measures = 129)),
            (
                "loop_region",
                Box::new(|s| {
                    s.loop_region = Some(LoopRegion {
                        region: Some(MeasureRegion {
                            start_measure: 3,
                            end_measure: 2,
                        }),
                        enabled: true,
                    })
                }),
            ),
            (
                "track_count",
                Box::new(|s| {
                    s.tracks = (0..17)
                        .map(|i| track(&format!("t{i}"), "T", "drums"))
                        .collect()
                }),
            ),
            (
                "track_name",
                Box::new(|s| s.tracks[0].name = "x".repeat(41)),
            ),
            ("volume", Box::new(|s| s.tracks[0].volume_db = 6.5)),
            ("pan", Box::new(|s| s.tracks[1].pan = -1.5)),
            (
                "unknown_instrument",
                Box::new(|s| s.tracks[1].instrument = "kazoo".into()),
            ),
            (
                "loop_count",
                Box::new(|s| {
                    s.tracks[0].loops = (0..65).map(|i| lp(&format!("x{i}"), 1, vec![])).collect();
                    s.tracks[0].clips.clear();
                }),
            ),
            (
                "clip_count",
                Box::new(|s| {
                    s.tracks[0].clips = (0..257)
                        .map(|i| clip(&format!("x{i}"), "l1", 1, 1))
                        .collect()
                }),
            ),
            (
                "duplicate_loop_id",
                Box::new(|s| s.tracks[1].loops[0].id = "l1".into()),
            ),
            (
                "loop_name",
                Box::new(|s| s.tracks[0].loops[0].name = String::new()),
            ),
            (
                "loop_length",
                Box::new(|s| s.tracks[0].loops[0].measures = 129),
            ),
            (
                "loop_note_row",
                Box::new(|s| s.tracks[1].loops[0].notes[0].row_id = "kick".into()),
            ),
            (
                "loop_note_range",
                Box::new(|s| s.tracks[0].loops[0].notes[0] = note("kick", 15, 2)),
            ),
            (
                "loop_note_range",
                Box::new(|s| s.tracks[0].loops[0].notes[0].velocity = 0),
            ),
            (
                "loop_note_overlap",
                Box::new(|s| {
                    s.tracks[0].loops[0].notes = vec![note("kick", 0, 4), note("kick", 2, 1)]
                }),
            ),
            (
                "duplicate_clip_id",
                Box::new(|s| s.tracks[1].clips[0].id = "c1".into()),
            ),
            (
                "clip_loop",
                Box::new(|s| s.tracks[1].clips[0].loop_id = "l1".into()),
            ),
            (
                "clip_position",
                Box::new(|s| s.tracks[0].clips[0].start_measure = 0),
            ),
            (
                "clip_length",
                Box::new(|s| s.tracks[0].clips[0].measures = 0),
            ),
            (
                "clip_overlap",
                Box::new(|s| {
                    s.tracks[0].clips = vec![clip("c9", "l1", 3, 2), clip("c1", "l1", 1, 3)]
                }),
            ),
            (
                "clip_outside_song",
                Box::new(|s| s.tracks[0].clips[0].measures = 5),
            ),
        ];
        for (kind, edit) in cases {
            assert_eq!(rejected(edit).kind().as_str(), kind);
        }
    }

    #[test]
    fn errors_name_the_offending_track() {
        let error = rejected(|s| s.tracks[1].clips[0].loop_id = "l1".into());
        assert!(error.to_string().contains("\"Piano\""), "{error}");
        let error = rejected(|s| s.tracks[1].instrument = "kazoo".into());
        assert!(matches!(error, SongError::UnknownInstrument { .. }));
        assert!(error.to_string().contains("\"Piano\""));
        assert!(error.to_string().contains("kazoo"));
    }

    #[test]
    fn a_song_with_no_tracks_is_valid() {
        let empty = song(4, vec![]);
        assert!(empty.validate(&InstrumentRegistry::builtin()).is_ok());
    }

    #[test]
    fn clip_input_order_does_not_matter() {
        let mut s = two_track_song();
        s.tracks[0].loops[0].measures = 1;
        s.tracks[0].clips = vec![clip("b", "l1", 3, 1), clip("a", "l1", 1, 1)];
        assert!(s.validate(&InstrumentRegistry::builtin()).is_ok());
    }

    #[test]
    fn key_and_loop_region_are_optional_and_null_is_accepted() {
        let mut value = serde_json::to_value(two_track_song()).unwrap();
        assert!(value.get("key").is_none());
        assert!(value.get("loop_region").is_none());
        value["loop_region"] = Value::Null;
        let s: Song = serde_json::from_value(value).unwrap();
        assert_eq!(s.loop_region, None);
        assert!(serde_json::to_value(&s)
            .unwrap()
            .get("loop_region")
            .is_none());
    }

    #[test]
    fn a_song_without_a_key_serializes_byte_identically() {
        let original = serde_json::to_string(&two_track_song()).unwrap();
        assert!(!original.contains("\"key\""));
        let reparsed: Song = serde_json::from_str(&original).unwrap();
        assert_eq!(serde_json::to_string(&reparsed).unwrap(), original);
    }

    #[test]
    fn key_and_loop_region_round_trip_in_the_browser_shape() {
        let mut s = two_track_song();
        s.key = Some(SongKey {
            tonic: Tonic::FSharp,
            mode: KeyMode::Minor,
        });
        s.loop_region = Some(LoopRegion {
            region: Some(MeasureRegion {
                start_measure: 1,
                end_measure: 2,
            }),
            enabled: true,
        });
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!(value["key"], json!({"tonic": "F#", "mode": "minor"}));
        assert_eq!(
            value["loop_region"],
            json!({"region": {"start_measure": 1, "end_measure": 2}, "enabled": true})
        );
        assert_eq!(serde_json::from_value::<Song>(value).unwrap(), s);
    }

    #[test]
    fn unknown_song_fields_are_ignored() {
        let mut value = serde_json::to_value(two_track_song()).unwrap();
        value["mood"] = json!("wistful");
        let s: Song = serde_json::from_value(value).unwrap();
        assert!(s.validate(&InstrumentRegistry::builtin()).is_ok());
    }

    fn load<T: DeserializeOwned>(raw: &str) -> T {
        serde_json::from_str(raw).unwrap()
    }

    #[derive(Deserialize)]
    struct ValidationFixture {
        cases: Vec<ValidationCase>,
    }

    #[derive(Deserialize)]
    struct ValidationCase {
        name: String,
        song: Value,
        /// `null` when the song is valid.
        error: Option<String>,
    }

    #[test]
    fn matches_shared_validation_fixture() {
        let fixture: ValidationFixture =
            load(include_str!("../../../../fixtures/song_validation.json"));
        let registry = InstrumentRegistry::builtin();
        assert!(fixture.cases.iter().any(|c| c.error.is_none()));
        for case in fixture.cases {
            let actual = match serde_json::from_value::<Song>(case.song.clone()) {
                Ok(song) => song.validate(&registry).err().map(|e| e.kind().as_str()),
                Err(e) => {
                    // The key is typed, so a bad tonic or mode is refused while
                    // deserializing; the browser reports the same case as `key`.
                    let mut without_key = case.song.clone();
                    without_key.as_object_mut().unwrap().remove("key");
                    assert!(
                        serde_json::from_value::<Song>(without_key).is_ok(),
                        "{}: does not deserialize: {e}",
                        case.name
                    );
                    Some("key")
                }
            };
            assert_eq!(actual, case.error.as_deref(), "{}", case.name);
        }
    }

    #[derive(Deserialize)]
    struct ResolutionFixture {
        cases: Vec<ResolutionCase>,
    }

    #[derive(Deserialize)]
    struct ResolutionCase {
        name: String,
        time_signature: TimeSignature,
        song_measures: u32,
        track: Track,
        expected: Vec<Note>,
    }

    #[test]
    fn matches_shared_clip_resolution_fixture() {
        let fixture: ResolutionFixture =
            load(include_str!("../../../../fixtures/clip_resolution.json"));
        for case in fixture.cases {
            let mut actual =
                resolve_track_notes(&case.track, case.time_signature.steps_per_measure());
            let key = |n: &Note| (n.step, n.row_id.clone());
            actual.sort_by_key(key);
            let mut expected = case.expected.clone();
            expected.sort_by_key(key);
            assert_eq!(actual, expected, "{}", case.name);

            let mut s = song(case.song_measures, vec![case.track.clone()]);
            s.time_signature = case.time_signature;
            s.steps_per_measure = case.time_signature.steps_per_measure();
            let valid = s
                .validate(&InstrumentRegistry::builtin())
                .unwrap_or_else(|e| panic!("{}: {e}", case.name));
            let mut stored = valid.tracks[0].notes.clone();
            stored.sort_by_key(key);
            assert_eq!(stored, expected, "{}: stored on ValidSong", case.name);
        }
    }

    fn audio_song() -> Song {
        let mut s = two_track_song();
        s.samples = vec![Sample {
            id: "s1".into(),
            name: "Break".into(),
            sample_rate: 48_000,
            channels: 2,
            length_samples: 120_000,
            origin: "import".into(),
        }];
        let mut loops = track("t3", "Loops", AUDIO_INSTRUMENT_ID);
        loops.audio_clips = vec![AudioClip {
            id: "a1".into(),
            sample_id: "s1".into(),
            start_ticks: 0,
            offset_samples: 0,
            slice_samples: 120_000,
            length_samples: 120_000,
            looping: false,
            gain_db: 0.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        }];
        s.tracks.push(loops);
        s
    }

    #[test]
    fn audio_tracks_resolve_to_the_audio_variant_with_no_notes() {
        let s = audio_song();
        let valid = s.validate(&InstrumentRegistry::builtin()).unwrap();
        assert!(valid.tracks[2].is_audio());
        assert!(valid.tracks[2].notes.is_empty());
        assert!(!valid.tracks[0].is_audio());
    }

    #[test]
    fn audio_fields_are_absent_from_songs_without_audio() {
        let value = serde_json::to_value(two_track_song()).unwrap();
        assert!(value.get("samples").is_none());
        assert!(value["tracks"][0].get("audio_clips").is_none());
    }

    #[test]
    fn audio_clip_loop_and_defaults_use_the_wire_names() {
        let clip: AudioClip = serde_json::from_value(json!({
            "id": "a", "sample_id": "s", "start_ticks": 0, "offset_samples": 0,
            "slice_samples": 10, "length_samples": 30, "loop": true,
        }))
        .unwrap();
        assert!(clip.looping);
        assert_eq!(
            (clip.gain_db, clip.fade_in_samples, clip.fade_out_samples),
            (0.0, 0, 0)
        );
        assert_eq!(serde_json::to_value(&clip).unwrap()["loop"], json!(true));
    }

    #[test]
    fn audio_errors_name_the_track_and_the_setting() {
        let mut s = audio_song();
        s.tracks[2].audio_clips[0].sample_id = "nope".into();
        let message = s
            .validate(&InstrumentRegistry::builtin())
            .unwrap_err()
            .to_string();
        assert!(message.contains("\"Loops\""), "{message}");

        let mut s = audio_song();
        s.tracks[2].sound = Some(TrackSound {
            tone: Some(Tone {
                filter_cutoff_hz: Some(2000.0),
                ..Tone::default()
            }),
            effects: None,
        });
        let message = s
            .validate(&InstrumentRegistry::builtin())
            .unwrap_err()
            .to_string();
        assert!(
            message.contains("\"Loops\"") && message.contains("filter_cutoff_hz"),
            "{message}"
        );
    }

    #[test]
    fn error_kind_helper_reports_unknown_instrument() {
        let mut s = two_track_song();
        s.tracks[0].instrument = "kazoo".into();
        assert_eq!(error_kind(&s), "unknown_instrument");
    }
}
