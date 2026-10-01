use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const STEPS_PER_QUARTER: u32 = 4;

pub const MIN_TEMPO_BPM: u32 = 40;
pub const MAX_TEMPO_BPM: u32 = 240;

pub const MIN_SWING: f64 = 0.0;
pub const MAX_SWING: f64 = 0.75;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS, JsonSchema,
)]
pub enum TimeSignature {
    #[default]
    #[serde(rename = "4/4")]
    FourFour,
    #[serde(rename = "3/4")]
    ThreeFour,
    #[serde(rename = "6/8")]
    SixEight,
}

impl TimeSignature {
    pub const ALL: [TimeSignature; 3] = [Self::FourFour, Self::ThreeFour, Self::SixEight];

    pub fn steps_per_measure(self) -> u32 {
        match self {
            Self::FourFour => 16,
            Self::ThreeFour | Self::SixEight => 12,
        }
    }

    /// 6/8 is felt in two dotted-quarter beats, so its beat lines fall every 6 steps.
    pub fn steps_per_beat(self) -> u32 {
        match self {
            Self::FourFour | Self::ThreeFour => 4,
            Self::SixEight => 6,
        }
    }

    pub fn numerator(self) -> u8 {
        match self {
            Self::FourFour => 4,
            Self::ThreeFour => 3,
            Self::SixEight => 6,
        }
    }

    pub fn denominator(self) -> u8 {
        match self {
            Self::FourFour | Self::ThreeFour => 4,
            Self::SixEight => 8,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FourFour => "4/4",
            Self::ThreeFour => "3/4",
            Self::SixEight => "6/8",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|ts| ts.as_str() == s.trim())
    }
}

/// A newtype so an unsupported length can never reach expansion or export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, TS)]
#[ts(type = "4 | 8 | 12 | 16 | 32")]
pub struct MeasureCount(u32);

impl Serialize for MeasureCount {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(self.0)
    }
}

impl<'de> Deserialize<'de> for MeasureCount {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u32::deserialize(deserializer)?;
        Self::try_from(value).map_err(serde::de::Error::custom)
    }
}

impl MeasureCount {
    pub const OPTIONS: [u32; 5] = [4, 8, 12, 16, 32];

    pub fn new(measures: u32) -> Option<Self> {
        Self::OPTIONS.contains(&measures).then_some(Self(measures))
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl Default for MeasureCount {
    fn default() -> Self {
        Self(4)
    }
}

impl TryFrom<u32> for MeasureCount {
    type Error = String;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        Self::new(value).ok_or_else(|| {
            format!(
                "measures must be one of {:?}, got {value}",
                MeasureCount::OPTIONS
            )
        })
    }
}

impl From<MeasureCount> for u32 {
    fn from(value: MeasureCount) -> Self {
        value.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_per_measure_per_time_signature() {
        assert_eq!(TimeSignature::FourFour.steps_per_measure(), 16);
        assert_eq!(TimeSignature::ThreeFour.steps_per_measure(), 12);
        assert_eq!(TimeSignature::SixEight.steps_per_measure(), 12);
    }

    #[test]
    fn time_signature_serializes_as_string() {
        assert_eq!(
            serde_json::to_string(&TimeSignature::SixEight).unwrap(),
            "\"6/8\""
        );
        assert_eq!(TimeSignature::parse("3/4"), Some(TimeSignature::ThreeFour));
        assert_eq!(TimeSignature::parse("5/4"), None);
    }

    #[test]
    fn measure_count_accepts_only_allowed_values() {
        for m in [4, 8, 12, 16, 32] {
            assert_eq!(MeasureCount::new(m).map(MeasureCount::get), Some(m));
        }
        assert_eq!(MeasureCount::new(10), None);
        assert_eq!(MeasureCount::new(64), None);
        assert!(serde_json::from_str::<MeasureCount>("10").is_err());
        assert!(serde_json::from_str::<MeasureCount>("64").is_err());
        assert_eq!(
            serde_json::from_str::<MeasureCount>("16").unwrap().get(),
            16
        );
    }
}
