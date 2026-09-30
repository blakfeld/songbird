//! Everything instrument-specific lives behind `Instrument` so the pattern
//! format, API, editor, playback, and export never change when one is added.

pub mod drums;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::draft::{MeasureNotes, PatternDraft};
use crate::pattern::Row;

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

#[derive(Debug)]
pub struct Instrument {
    pub id: &'static str,
    pub name: &'static str,
    /// Stored 1-based because that is how users and DAWs number channels; the
    /// SMF writer subtracts one.
    pub midi_channel: u8,
    /// Decides whether playback honours `length_steps` (melodic) or always plays
    /// the whole sample (drums).
    pub sustained: bool,
    pub rows: &'static [RowDef],
    pub system_prompt: &'static str,
    /// (alias, row id): models often use shorthand rather than the schema's ids.
    pub row_aliases: &'static [(&'static str, &'static str)],
    pub examples: &'static [ExampleDraft],
    pub fallback_variation: Option<FallbackVariation>,
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
            midi_channel: self.midi_channel,
            sustained: self.sustained,
            rows: self.row_list(),
        }
    }

    pub fn row_index(&self, id: &str) -> Option<usize> {
        self.rows.iter().position(|r| r.id == id)
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
    pub midi_channel: u8,
    pub sustained: bool,
    pub rows: Vec<Row>,
}

static BUILTIN: [&Instrument; 1] = [&drums::DRUMS];

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
    pub const fn builtin() -> Self {
        Self {
            instruments: &BUILTIN,
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
    fn registry_lists_exactly_drums() {
        let ids: Vec<_> = InstrumentRegistry::builtin()
            .all()
            .iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ids, ["drums"]);
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
    }
}
