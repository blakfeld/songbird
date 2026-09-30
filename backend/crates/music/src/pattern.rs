use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instruments::Instrument;
use crate::meter::{MeasureCount, TimeSignature};

/// Lets clients recognize documents saved (e.g. in localStorage) by an older format.
pub const PATTERN_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Pattern {
    pub version: u32,
    pub instrument: String,
    pub name: String,
    pub tempo_bpm: u32,
    pub time_signature: TimeSignature,
    pub measures: MeasureCount,
    pub steps_per_measure: u32,
    pub swing: f64,
    pub midi_channel: u8,
    pub rows: Vec<Row>,
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub midi_note: u8,
}

/// `step` is absolute rather than per-measure so notes survive length changes
/// and map directly to playback times and MIDI ticks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Note {
    pub row_id: String,
    pub step: u32,
    pub length_steps: u32,
    pub velocity: u8,
}

impl Pattern {
    /// The pattern copies the instrument's rows and channel so playback and
    /// export need nothing but the document.
    pub fn empty(
        instrument: &Instrument,
        name: impl Into<String>,
        tempo_bpm: u32,
        time_signature: TimeSignature,
        measures: MeasureCount,
        swing: f64,
    ) -> Self {
        Self {
            version: PATTERN_VERSION,
            instrument: instrument.id.to_string(),
            name: name.into(),
            tempo_bpm,
            time_signature,
            measures,
            steps_per_measure: time_signature.steps_per_measure(),
            swing,
            midi_channel: instrument.midi_channel,
            rows: instrument.row_list(),
            notes: Vec::new(),
        }
    }

    pub fn total_steps(&self) -> u32 {
        self.measures.get().saturating_mul(self.steps_per_measure)
    }

    pub fn row(&self, id: &str) -> Option<&Row> {
        self.rows.iter().find(|r| r.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::drums::DRUMS;

    #[test]
    fn empty_pattern_derives_steps_per_measure() {
        let p = Pattern::empty(
            &DRUMS,
            "x",
            120,
            TimeSignature::ThreeFour,
            MeasureCount::new(8).unwrap(),
            0.0,
        );
        assert_eq!(p.steps_per_measure, 12);
        assert_eq!(p.total_steps(), 96);
    }

    #[test]
    fn empty_pattern_copies_instrument_rows_and_channel() {
        let p = Pattern::empty(
            &DRUMS,
            "x",
            120,
            TimeSignature::FourFour,
            MeasureCount::default(),
            0.0,
        );
        assert_eq!(p.instrument, "drums");
        assert_eq!(p.midi_channel, 10);
        assert_eq!(p.rows.len(), 12);
    }

    #[test]
    fn pattern_round_trips_as_json() {
        let mut p = Pattern::empty(
            &DRUMS,
            "Groove",
            90,
            TimeSignature::FourFour,
            MeasureCount::default(),
            0.2,
        );
        p.notes.push(Note {
            row_id: "kick".into(),
            step: 0,
            length_steps: 4,
            velocity: 110,
        });
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["time_signature"], "4/4");
        assert_eq!(json["measures"], 4);
        assert_eq!(json["notes"][0]["length_steps"], 4);
        let back: Pattern = serde_json::from_value(json).unwrap();
        assert_eq!(back, p);
    }
}
