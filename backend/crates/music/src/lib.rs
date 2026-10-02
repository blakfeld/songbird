//! Kept free of instrument-specific code (outside `instruments`) so future
//! instruments can reuse timing, MIDI writing, and AI transports unchanged.

pub mod ai;
pub mod chat;
pub mod context;
pub mod draft;
pub mod expand;
pub mod generate;
pub mod instruments;
pub mod lyrics;
pub mod meter;
pub mod midi;
pub mod pattern;
pub mod request;
pub mod song;
pub mod song_midi;
pub mod timing;
pub mod tokens;
pub mod track_generation;

pub use chat::{ChatBody, ChatMessage, ChatRequestError, ChatResponse, ChatTrack};
pub use draft::{DraftError, NormalizedDraft, PatternDraft};
pub use expand::build_pattern;
pub use instruments::{Instrument, InstrumentInfo, InstrumentRegistry};
pub use lyrics::{
    LyricSelection, LyricSuggestion, LyricsAssistBody, LyricsAssistResponse, LyricsRequestError,
    LyricsSectionContext, LyricsSongContext, SuggestionAction,
};
pub use meter::{MeasureCount, TimeSignature};
pub use pattern::{Note, Pattern, Row};
pub use request::{GenerateRequest, GenerateRequestBody, GenerationLimits, ValidationError};
pub use song::{Clip, Loop, Song, SongError, Track, ValidSong};
pub use tokens::estimate_tokens;
pub use track_generation::{
    MeasureRange, SongLimits, TrackGenerateBody, TrackGenerateResponse, TrackRequestError,
    ValidTrackRequest,
};
