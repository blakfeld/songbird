//! Kept free of instrument-specific code (outside `instruments`) so future
//! instruments can reuse timing, MIDI writing, and AI transports unchanged.

pub mod ai;
pub mod draft;
pub mod expand;
pub mod generate;
pub mod instruments;
pub mod meter;
pub mod midi;
pub mod pattern;
pub mod request;
pub mod timing;
pub mod tokens;

pub use draft::{DraftError, NormalizedDraft, PatternDraft};
pub use expand::build_pattern;
pub use instruments::{Instrument, InstrumentInfo, InstrumentRegistry};
pub use meter::{MeasureCount, TimeSignature};
pub use pattern::{Note, Pattern, Row};
pub use request::{GenerateRequest, GenerateRequestBody, GenerationLimits, ValidationError};
pub use tokens::estimate_tokens;
