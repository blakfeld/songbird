use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instruments::{Instrument, InstrumentRegistry};
use crate::meter::{
    MeasureCount, TimeSignature, MAX_SWING, MAX_TEMPO_BPM, MIN_SWING, MIN_TEMPO_BPM,
};
use crate::tokens::estimate_tokens;

/// Published so clients enforce the same limits the server does, without
/// hard-coding them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct GenerationLimits {
    pub max_input_tokens: u32,
    pub measure_options: Vec<u32>,
}

impl GenerationLimits {
    pub fn new(max_input_tokens: u32) -> Self {
        Self {
            max_input_tokens,
            measure_options: MeasureCount::OPTIONS.to_vec(),
        }
    }
}

/// Fields are deliberately loose (`i64`/`f64`, `instrument` defaulting to
/// empty) so missing or out-of-range values reach `validate` and get a
/// specific error code instead of a generic JSON rejection.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct GenerateRequestBody {
    #[serde(default)]
    pub instrument: String,
    pub prompt: String,
    #[ts(type = "number")]
    pub measures: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub tempo_bpm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub time_signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub swing: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct GenerateRequest {
    pub instrument: &'static Instrument,
    pub prompt: String,
    /// A plain count because song ranges can be any length up to 32; pattern
    /// requests are still limited to `MeasureCount`'s options by `validate`.
    pub measures: u32,
    pub tempo_bpm: Option<u32>,
    pub time_signature: TimeSignature,
    pub swing: Option<f64>,
    /// Already rendered and fence-escaped by `context::render_context`, so the
    /// prompt can embed it verbatim.
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ValidationError {
    #[error("Unknown instrument; choose one of the instruments the service offers.")]
    InvalidInstrument,
    #[error("Describe what you want; the prompt cannot be empty.")]
    InvalidPrompt,
    #[error("The description is too long ({estimate} estimated tokens; the limit is {limit}). Please shorten it.")]
    PromptTooLong { estimate: u32, limit: u32 },
    #[error("Measures must be one of 4, 8, 12, 16, or 32.")]
    InvalidMeasures,
    #[error("Tempo must be a whole number of BPM between 40 and 240.")]
    InvalidTempo,
    #[error("Time signature must be one of \"4/4\", \"3/4\", or \"6/8\".")]
    InvalidTimeSignature,
    #[error("Swing must be between 0 and 0.75.")]
    InvalidSwing,
}

impl ValidationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInstrument => "invalid_instrument",
            Self::InvalidPrompt => "invalid_prompt",
            Self::PromptTooLong { .. } => "prompt_too_long",
            Self::InvalidMeasures => "invalid_measures",
            Self::InvalidTempo => "invalid_tempo",
            Self::InvalidTimeSignature => "invalid_time_signature",
            Self::InvalidSwing => "invalid_swing",
        }
    }
}

/// Shared so every endpoint that takes a description applies the same rules and
/// returns the same error codes.
pub fn validate_prompt(prompt: &str, max_input_tokens: u32) -> Result<String, ValidationError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(ValidationError::InvalidPrompt);
    }
    let estimate = estimate_tokens(prompt);
    if estimate > max_input_tokens {
        return Err(ValidationError::PromptTooLong {
            estimate,
            limit: max_input_tokens,
        });
    }
    Ok(prompt.to_string())
}

impl GenerateRequestBody {
    pub fn validate(
        &self,
        instruments: &InstrumentRegistry,
        max_input_tokens: u32,
    ) -> Result<GenerateRequest, ValidationError> {
        let instrument = instruments
            .get(&self.instrument)
            .ok_or(ValidationError::InvalidInstrument)?;
        let prompt = validate_prompt(&self.prompt, max_input_tokens)?;
        let measures = u32::try_from(self.measures)
            .ok()
            .and_then(MeasureCount::new)
            .ok_or(ValidationError::InvalidMeasures)?;
        let tempo_bpm = match self.tempo_bpm {
            None => None,
            Some(t)
                if t.fract() == 0.0
                    && (MIN_TEMPO_BPM as f64..=MAX_TEMPO_BPM as f64).contains(&t) =>
            {
                Some(t as u32)
            }
            Some(_) => return Err(ValidationError::InvalidTempo),
        };
        let time_signature = match &self.time_signature {
            None => TimeSignature::default(),
            Some(s) => TimeSignature::parse(s).ok_or(ValidationError::InvalidTimeSignature)?,
        };
        let swing = match self.swing {
            None => None,
            Some(s) if (MIN_SWING..=MAX_SWING).contains(&s) => Some(s),
            Some(_) => return Err(ValidationError::InvalidSwing),
        };
        Ok(GenerateRequest {
            instrument,
            prompt,
            measures: measures.get(),
            tempo_bpm,
            time_signature,
            swing,
            context: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(prompt: &str) -> GenerateRequestBody {
        GenerateRequestBody {
            instrument: "drums".into(),
            prompt: prompt.into(),
            measures: 4,
            ..Default::default()
        }
    }

    fn validate(b: &GenerateRequestBody, limit: u32) -> Result<GenerateRequest, ValidationError> {
        b.validate(&InstrumentRegistry::builtin(), limit)
    }

    fn code(b: GenerateRequestBody) -> &'static str {
        validate(&b, 256).unwrap_err().code()
    }

    #[test]
    fn defaults_are_applied() {
        let r = validate(&body("  four on the floor  "), 256).unwrap();
        assert_eq!(r.instrument.id, "drums");
        assert_eq!(r.prompt, "four on the floor");
        assert_eq!(r.measures, 4);
        assert_eq!(r.time_signature, TimeSignature::FourFour);
        assert_eq!(r.tempo_bpm, None);
        assert_eq!(r.swing, None);
    }

    #[test]
    fn invalid_instrument() {
        for instrument in ["kazoo", ""] {
            assert_eq!(
                code(GenerateRequestBody {
                    instrument: instrument.into(),
                    ..body("x")
                }),
                "invalid_instrument"
            );
        }
    }

    #[test]
    fn missing_instrument_field_deserializes_to_invalid_instrument() {
        let b: GenerateRequestBody =
            serde_json::from_str(r#"{"prompt": "x", "measures": 4}"#).unwrap();
        assert_eq!(code(b), "invalid_instrument");
    }

    #[test]
    fn invalid_prompt() {
        assert_eq!(code(body("   ")), "invalid_prompt");
        assert_eq!(code(body("")), "invalid_prompt");
    }

    #[test]
    fn prompt_too_long_boundary() {
        assert!(validate(&body(&"a".repeat(1024)), 256).is_ok());
        assert_eq!(code(body(&"a".repeat(1025))), "prompt_too_long");
        assert!(validate(&body(&"🥁".repeat(1024)), 256).is_ok());
        assert_eq!(
            validate(&body(&"a".repeat(513)), 128).unwrap_err().code(),
            "prompt_too_long"
        );
    }

    #[test]
    fn invalid_measures() {
        for m in [0, 10, 64, -4] {
            assert_eq!(
                code(GenerateRequestBody {
                    measures: m,
                    ..body("x")
                }),
                "invalid_measures"
            );
        }
    }

    #[test]
    fn invalid_tempo() {
        for t in [300.0, 39.0, 241.0, 120.5] {
            assert_eq!(
                code(GenerateRequestBody {
                    tempo_bpm: Some(t),
                    ..body("x")
                }),
                "invalid_tempo"
            );
        }
        let ok = GenerateRequestBody {
            tempo_bpm: Some(140.0),
            ..body("x")
        };
        assert_eq!(validate(&ok, 256).unwrap().tempo_bpm, Some(140));
    }

    #[test]
    fn invalid_time_signature() {
        assert_eq!(
            code(GenerateRequestBody {
                time_signature: Some("5/4".into()),
                ..body("x")
            }),
            "invalid_time_signature"
        );
    }

    #[test]
    fn invalid_swing() {
        for s in [-0.1, 0.8] {
            assert_eq!(
                code(GenerateRequestBody {
                    swing: Some(s),
                    ..body("x")
                }),
                "invalid_swing"
            );
        }
    }
}
