//! Everything instrument-specific lives behind `Instrument` so the pattern
//! format, API, editor, playback, and export never change when one is added.

pub mod bass;
pub mod drums;
pub mod electric_piano;
pub mod melodic;
pub mod organ;
pub mod piano;
pub mod pitch;
pub mod pluck;
pub mod sampler;
pub mod strings;
pub mod synth_lead;
pub mod synth_pad;

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::draft::{MeasureNotes, PatternDraft};
use crate::pattern::Row;
use pitch::parse_pitch;

#[derive(Debug)]
pub struct RowDef {
    pub id: &'static str,
    pub name: &'static str,
    pub midi_note: u8,
}

/// Producing a variation is instrument-specific (a snare roll means nothing
/// on a bass), so the generic expander delegates to this hook.
pub type FallbackVariation = fn(primary: &MeasureNotes, steps_per_measure: u32) -> MeasureNotes;

#[derive(Debug)]
pub struct ExampleDraft {
    pub genre: &'static str,
    /// Matched against the lowercased prompt so the mock picks a fitting groove.
    pub keywords: &'static [&'static str],
    pub json: &'static str,
}

impl ExampleDraft {
    pub fn draft(&self) -> PatternDraft {
        serde_json::from_str(self.json).expect("built-in example drafts are valid")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum InstrumentKind {
    Drums,
    Melodic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PitchRange {
    pub low: u8,
    pub high: u8,
}

impl PitchRange {
    /// Shifts by whole octaves so a model's out-of-range voicing keeps its
    /// pitch class instead of being dropped. A range narrower than an octave
    /// can lack the pitch class entirely, hence the `None`.
    pub fn fold(self, pitch: i32) -> Option<u8> {
        let (low, high) = (i32::from(self.low), i32::from(self.high));
        let folded = if pitch > high {
            pitch - (pitch - high + 11) / 12 * 12
        } else if pitch < low {
            pitch + (low - pitch + 11) / 12 * 12
        } else {
            pitch
        };
        (low..=high).contains(&folded).then_some(folded as u8)
    }
}

/// Models often stack notes on lines that should be single-voiced, and prompts
/// alone do not reliably prevent it, so generation enforces it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Monophony {
    #[default]
    None,
    KeepLowest,
    KeepHighest,
}

#[derive(Debug)]
pub struct Instrument {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: InstrumentKind,
    /// Stored 1-based because that is how users and DAWs number channels; the
    /// SMF writer subtracts one.
    pub midi_channel: u8,
    /// General MIDI program, 1-based like channels; drums select their kit by
    /// channel instead.
    pub midi_program: Option<u8>,
    pub range: Option<PitchRange>,
    /// Decides whether playback honours `length_steps` (melodic) or always plays
    /// the whole sample (drums).
    pub sustained: bool,
    pub rows: &'static [RowDef],
    pub system_prompt: &'static str,
    /// (alias, row id): models often use shorthand rather than the schema's ids.
    pub row_aliases: &'static [(&'static str, &'static str)],
    pub examples: &'static [ExampleDraft],
    pub fallback_variation: Option<FallbackVariation>,
    /// Deliberately absent from `InstrumentInfo`: it constrains generation,
    /// not what the user may enter in the editor.
    pub monophony: Monophony,
}

impl Instrument {
    pub fn row_list(&self) -> Vec<Row> {
        self.rows
            .iter()
            .map(|r| Row {
                id: r.id.to_string(),
                name: r.name.to_string(),
                midi_note: r.midi_note,
            })
            .collect()
    }

    pub fn info(&self) -> InstrumentInfo {
        InstrumentInfo {
            id: self.id.to_string(),
            name: self.name.to_string(),
            kind: self.kind,
            midi_channel: self.midi_channel,
            midi_program: self.midi_program,
            range: self.range,
            sustained: self.sustained,
            rows: self.row_list(),
        }
    }

    pub fn row_index(&self, id: &str) -> Option<usize> {
        self.rows.iter().position(|r| r.id == id)
    }

    /// Melodic lanes are pitches (any spelling, folded into range) rather than
    /// row ids, because models write flats and MIDI numbers the schema forbids.
    pub fn resolve_lane(&self, raw: &str) -> Option<usize> {
        match (self.kind, self.range) {
            (InstrumentKind::Melodic, Some(range)) => {
                let midi = range.fold(parse_pitch(raw)?)?;
                self.rows.iter().position(|r| r.midi_note == midi)
            }
            _ => self.resolve_row(raw),
        }
    }

    /// Accepts row ids and aliases in any case, with `-` or spaces for `_`.
    pub fn resolve_row(&self, raw: &str) -> Option<usize> {
        let key = raw.trim().to_ascii_lowercase().replace(['-', ' '], "_");
        self.row_index(&key).or_else(|| {
            self.row_aliases
                .iter()
                .find(|(alias, _)| *alias == key)
                .and_then(|(_, id)| self.row_index(id))
        })
    }
}

/// Published so the editor builds its rows from the server instead of
/// hard-coding them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct InstrumentInfo {
    pub id: String,
    pub name: String,
    pub kind: InstrumentKind,
    pub midi_channel: u8,
    pub midi_program: Option<u8>,
    pub range: Option<PitchRange>,
    pub sustained: bool,
    pub rows: Vec<Row>,
}

/// Lazy because the piano's rows are built at first use.
static BUILTIN: LazyLock<[&'static Instrument; 9]> = LazyLock::new(|| {
    [
        &drums::DRUMS,
        &piano::PIANO,
        &electric_piano::ELECTRIC_PIANO,
        &organ::ORGAN,
        &bass::BASS,
        &synth_lead::SYNTH_LEAD,
        &synth_pad::SYNTH_PAD,
        &strings::STRINGS,
        &pluck::PLUCK,
    ]
});

#[derive(Clone, Copy)]
pub struct InstrumentRegistry {
    instruments: &'static [&'static Instrument],
}

impl std::fmt::Debug for InstrumentRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.instruments.iter().map(|i| i.id))
            .finish()
    }
}

impl InstrumentRegistry {
    pub fn builtin() -> Self {
        Self {
            instruments: &*BUILTIN,
        }
    }

    pub fn all(&self) -> &'static [&'static Instrument] {
        self.instruments
    }

    pub fn get(&self, id: &str) -> Option<&'static Instrument> {
        self.instruments.iter().copied().find(|i| i.id == id)
    }

    pub fn infos(&self) -> Vec<InstrumentInfo> {
        self.instruments.iter().map(|i| i.info()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_instruments_in_catalog_order() {
        let ids: Vec<_> = InstrumentRegistry::builtin()
            .all()
            .iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(
            ids,
            [
                "drums",
                "piano",
                "electric-piano",
                "organ",
                "bass",
                "synth-lead",
                "synth-pad",
                "strings",
                "pluck"
            ]
        );
    }

    #[test]
    fn unknown_instrument_lookup_fails() {
        let registry = InstrumentRegistry::builtin();
        assert!(registry.get("kazoo").is_none());
        assert!(registry.get("").is_none());
        assert_eq!(registry.get("drums").unwrap().id, "drums");
    }

    #[test]
    fn info_mirrors_definition() {
        let info = InstrumentRegistry::builtin().get("drums").unwrap().info();
        assert_eq!(info.midi_channel, 10);
        assert!(!info.sustained);
        assert_eq!(info.rows.len(), 12);
        assert_eq!(info.kind, InstrumentKind::Drums);
        assert_eq!(info.midi_program, None);
        assert_eq!(info.range, None);
    }

    #[test]
    fn fold_moves_to_the_nearest_octave_in_range() {
        let range = PitchRange { low: 36, high: 96 };
        assert_eq!(range.fold(100), Some(88));
        assert_eq!(range.fold(60), Some(60));
        assert_eq!(range.fold(24), Some(36));
        assert_eq!(range.fold(127), Some(91));
        assert_eq!(range.fold(0), Some(36));
    }

    #[test]
    fn fold_drops_pitch_classes_a_narrow_range_lacks() {
        let range = PitchRange { low: 60, high: 64 };
        assert_eq!(range.fold(72), Some(60));
        assert_eq!(range.fold(67), None);
        assert_eq!(range.fold(55), None);
    }
}
