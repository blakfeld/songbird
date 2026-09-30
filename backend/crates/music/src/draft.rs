//! Providers return a compact sections + arrangement form instead of every
//! note because enumerating up to 32 measures of notes is slow, costly, and
//! error-prone for LLMs. Normalization lives here, not in providers, so every
//! provider's output gets identical validation.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::instruments::Instrument;
use crate::meter::{MAX_SWING, MAX_TEMPO_BPM, MIN_SWING, MIN_TEMPO_BPM};

pub const GHOST_VELOCITY: u8 = 35;
pub const NORMAL_VELOCITY: u8 = 90;
pub const ACCENT_VELOCITY: u8 = 120;

pub const FALLBACK_TEMPO_BPM: u32 = 120;
pub const MAX_NAME_CHARS: usize = 60;
const FALLBACK_NAME: &str = "Untitled Pattern";

/// Deserialization is lenient (missing optional fields, unknown lanes, wrong
/// lengths) so a mostly-good draft is repaired rather than retried. Sections
/// and lanes are arrays, not maps, because strict structured-output modes
/// reject free-form object keys.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(
    deny_unknown_fields,
    description = "A compact pattern: reusable one-measure sections plus an arrangement listing the section for each measure."
)]
pub struct PatternDraft {
    #[schemars(description = "Short human-readable title, e.g. \"Dusty Boom Bap\".")]
    pub name: String,
    #[schemars(
        description = "Tempo in BPM (40-240) suited to the description, or null to use the requested tempo."
    )]
    #[serde(default)]
    pub tempo_bpm: Option<f64>,
    #[schemars(
        description = "Swing 0-0.75 (fraction of a sixteenth that off-beat sixteenths are delayed), or null."
    )]
    #[serde(default)]
    pub swing: Option<f64>,
    #[schemars(
        description = "One-measure building blocks, e.g. a main groove \"A\" and a \"fill\"."
    )]
    pub sections: Vec<DraftSection>,
    #[schemars(
        description = "Section id for each measure in order; repeated cyclically to fill the requested length."
    )]
    pub arrangement: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct DraftSection {
    #[schemars(
        description = "Section identifier referenced by arrangement, e.g. \"A\" or \"fill\"."
    )]
    pub id: String,
    #[schemars(description = "The lanes that play in this section; omit silent lanes.")]
    pub lanes: Vec<DraftLane>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct DraftLane {
    #[schemars(description = "A row id of the requested instrument.")]
    pub lane: String,
    pub steps: LaneSteps,
}

/// Strings keep output compact; velocity arrays exist for finer dynamics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(description = "Either a step string or an array of per-step velocities.")]
pub enum LaneSteps {
    #[schemars(
        description = "One character per sixteenth step of one measure: '.' rest, 'g' ghost, 'x' normal, 'X' accent, '-' hold (extends the previous note by one step)."
    )]
    Pattern(String),
    #[schemars(
        description = "One velocity per sixteenth step of one measure, 0 for a rest, otherwise 1-127; every note has length 1."
    )]
    Velocities(#[schemars(with = "Vec<u8>")] Vec<f64>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectionNote {
    pub velocity: u8,
    pub length: u32,
}

/// Keyed by (row index, step) so duplicate notes are impossible by construction.
pub type MeasureNotes = BTreeMap<(usize, u32), SectionNote>;

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedDraft {
    pub name: String,
    pub tempo_bpm: Option<u32>,
    pub swing: Option<f64>,
    pub sections: Vec<MeasureNotes>,
    /// Never empty: expansion indexes it modulo its length.
    pub arrangement: Vec<usize>,
}

/// All variants are worth one retry: models often succeed on a second attempt.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum DraftError {
    #[error("draft is not valid JSON for the draft format: {0}")]
    Parse(String),
    #[error("draft has no sections")]
    NoSections,
    #[error("draft contains no notes")]
    NoNotes,
}

impl PatternDraft {
    pub fn from_json(value: serde_json::Value) -> Result<Self, DraftError> {
        serde_json::from_value(value).map_err(|e| DraftError::Parse(e.to_string()))
    }

    pub fn normalize(
        &self,
        instrument: &Instrument,
        steps_per_measure: u32,
    ) -> Result<NormalizedDraft, DraftError> {
        if self.sections.is_empty() {
            return Err(DraftError::NoSections);
        }
        let mut ids: Vec<&str> = Vec::new();
        let mut sections: Vec<MeasureNotes> = Vec::new();
        for section in &self.sections {
            let notes = parse_section(section, instrument, steps_per_measure);
            let id = section.id.trim();
            // Models sometimes split one section across two entries with the same id.
            match ids.iter().position(|existing| *existing == id) {
                Some(i) => merge_loudest(&mut sections[i], notes),
                None => {
                    ids.push(id);
                    sections.push(notes);
                }
            }
        }
        if sections.iter().all(BTreeMap::is_empty) {
            return Err(DraftError::NoNotes);
        }
        let mut arrangement: Vec<usize> = self
            .arrangement
            .iter()
            .filter_map(|id| ids.iter().position(|s| *s == id.trim()))
            .collect();
        if arrangement.is_empty() {
            arrangement = (0..sections.len()).collect();
        }
        Ok(NormalizedDraft {
            name: normalize_name(&self.name),
            tempo_bpm: self.tempo_bpm.and_then(normalize_tempo),
            swing: self
                .swing
                .filter(|s| s.is_finite())
                .map(|s| s.clamp(MIN_SWING, MAX_SWING)),
            sections,
            arrangement,
        })
    }
}

fn parse_section(
    section: &DraftSection,
    instrument: &Instrument,
    steps_per_measure: u32,
) -> MeasureNotes {
    let mut notes = MeasureNotes::new();
    for lane in &section.lanes {
        let Some(row) = instrument.resolve_lane(&lane.lane) else {
            continue;
        };
        let lane_notes = match &lane.steps {
            LaneSteps::Pattern(s) => parse_step_string(row, s, steps_per_measure),
            LaneSteps::Velocities(v) => parse_velocities(row, v, steps_per_measure),
        };
        merge_loudest(&mut notes, lane_notes);
    }
    notes
}

fn parse_step_string(row: usize, steps: &str, steps_per_measure: u32) -> MeasureNotes {
    let mut notes = MeasureNotes::new();
    let mut held_note_start: Option<u32> = None;
    let cells = steps
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '|')
        .take(steps_per_measure as usize);
    for (step, c) in cells.enumerate() {
        let step = step as u32;
        let velocity = match c {
            'g' | 'G' => GHOST_VELOCITY,
            'x' => NORMAL_VELOCITY,
            'X' => ACCENT_VELOCITY,
            '-' => {
                // A hold after a rest has nothing to extend, so it stays a rest.
                if let Some(note) = held_note_start.and_then(|s| notes.get_mut(&(row, s))) {
                    note.length += 1;
                }
                continue;
            }
            _ => {
                held_note_start = None;
                continue;
            }
        };
        notes.insert(
            (row, step),
            SectionNote {
                velocity,
                length: 1,
            },
        );
        held_note_start = Some(step);
    }
    notes
}

fn parse_velocities(row: usize, velocities: &[f64], steps_per_measure: u32) -> MeasureNotes {
    velocities
        .iter()
        .take(steps_per_measure as usize)
        .enumerate()
        .filter_map(|(step, &v)| {
            let velocity = clamp_velocity(v);
            (velocity > 0).then_some((
                (row, step as u32),
                SectionNote {
                    velocity,
                    length: 1,
                },
            ))
        })
        .collect()
}

/// On duplicates the loudest wins so an accent is never lost to a ghost note;
/// on equal velocity the longer note wins so a hold is not lost.
fn merge_loudest(into: &mut MeasureNotes, from: MeasureNotes) {
    for (key, note) in from {
        into.entry(key)
            .and_modify(|existing| {
                if (note.velocity, note.length) > (existing.velocity, existing.length) {
                    *existing = note;
                }
            })
            .or_insert(note);
    }
}

/// Rounding before the rest check stops near-zero values becoming audible notes.
pub fn clamp_velocity(v: f64) -> u8 {
    let v = v.round();
    if !v.is_finite() || v <= 0.0 {
        return 0;
    }
    v.min(127.0) as u8
}

fn normalize_tempo(t: f64) -> Option<u32> {
    t.is_finite()
        .then(|| (t.round() as i64).clamp(MIN_TEMPO_BPM as i64, MAX_TEMPO_BPM as i64) as u32)
}

fn normalize_name(name: &str) -> String {
    let collapsed: String = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed.chars().take(MAX_NAME_CHARS).collect();
    if truncated.is_empty() {
        FALLBACK_NAME.to_string()
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::drums::DRUMS;
    use serde_json::json;

    fn row(id: &str) -> usize {
        DRUMS.resolve_row(id).unwrap()
    }

    fn draft(value: serde_json::Value) -> PatternDraft {
        PatternDraft::from_json(value).unwrap()
    }

    fn note(velocity: u8, length: u32) -> SectionNote {
        SectionNote { velocity, length }
    }

    fn single_lane(lane: &str, steps: serde_json::Value) -> PatternDraft {
        draft(json!({
            "name": "T",
            "sections": [{"id": "A", "lanes": [{"lane": lane, "steps": steps}]}],
            "arrangement": ["A"]
        }))
    }

    #[test]
    fn parses_step_strings() {
        let n = single_lane("kick", json!("x...X...g.......|"))
            .normalize(&DRUMS, 16)
            .unwrap();
        let k = row("kick");
        let expected: MeasureNotes = [
            ((k, 0), note(90, 1)),
            ((k, 4), note(120, 1)),
            ((k, 8), note(35, 1)),
        ]
        .into_iter()
        .collect();
        assert_eq!(n.sections[0], expected);
        assert_eq!(n.tempo_bpm, None);
        assert_eq!(n.swing, None);
    }

    #[test]
    fn holds_extend_the_previous_note() {
        let n = single_lane("crash", json!("x---....X-.x"))
            .normalize(&DRUMS, 16)
            .unwrap();
        let c = row("crash");
        let expected: MeasureNotes = [
            ((c, 0), note(90, 4)),
            ((c, 8), note(120, 2)),
            ((c, 11), note(90, 1)),
        ]
        .into_iter()
        .collect();
        assert_eq!(n.sections[0], expected);
    }

    #[test]
    fn hold_after_a_rest_is_a_rest() {
        let n = single_lane("kick", json!("x.--x-"))
            .normalize(&DRUMS, 16)
            .unwrap();
        let k = row("kick");
        let expected: MeasureNotes = [((k, 0), note(90, 1)), ((k, 4), note(90, 2))]
            .into_iter()
            .collect();
        assert_eq!(n.sections[0], expected);
        let leading = single_lane("kick", json!("-x"))
            .normalize(&DRUMS, 16)
            .unwrap();
        assert_eq!(leading.sections[0].len(), 1);
    }

    #[test]
    fn hold_cannot_run_past_the_measure() {
        let n = single_lane("kick", json!("..........x-----------"))
            .normalize(&DRUMS, 12)
            .unwrap();
        assert_eq!(n.sections[0][&(row("kick"), 10)], note(90, 2));
    }

    #[test]
    fn velocity_arrays_are_clamped_with_length_one() {
        let n = single_lane("snare", json!([200, 0, -5, 0.4, 64.6, 1]))
            .normalize(&DRUMS, 16)
            .unwrap();
        let s = row("snare");
        let expected: MeasureNotes = [
            ((s, 0), note(127, 1)),
            ((s, 4), note(65, 1)),
            ((s, 5), note(1, 1)),
        ]
        .into_iter()
        .collect();
        assert_eq!(n.sections[0], expected);
    }

    #[test]
    fn wrong_length_step_strings_are_padded_or_truncated() {
        let d = draft(json!({
            "name": "Len",
            "sections": [{"id": "A", "lanes": [
                {"lane": "kick", "steps": "x..."},
                {"lane": "hat_closed", "steps": "x.x.x.x.x.x.x.x.x.x.x.x."},
            ]}],
            "arrangement": ["A"]
        }));
        let n = d.normalize(&DRUMS, 12).unwrap();
        assert_eq!(n.sections[0].len(), 1 + 6);
        assert!(n.sections[0].keys().all(|(_, step)| *step < 12));
        assert!(n.sections[0].contains_key(&(row("hat_closed"), 10)));
    }

    #[test]
    fn unknown_lanes_are_dropped_and_aliases_resolved() {
        let d = draft(json!({
            "name": "Alias",
            "sections": [{"id": "A", "lanes": [
                {"lane": "cowbell", "steps": "xxxxxxxxxxxxxxxx"},
                {"lane": "Hi-Hat", "steps": "x..............."},
            ]}],
            "arrangement": ["A"]
        }));
        let n = d.normalize(&DRUMS, 16).unwrap();
        let expected: MeasureNotes = [((row("hat_closed"), 0), note(90, 1))]
            .into_iter()
            .collect();
        assert_eq!(n.sections[0], expected);
    }

    #[test]
    fn duplicates_are_removed_keeping_the_loudest() {
        let d = draft(json!({
            "name": "Dup",
            "sections": [
                {"id": "A", "lanes": [
                    {"lane": "kick", "steps": "g..............."},
                    {"lane": "bd", "steps": "X..............."},
                ]},
                {"id": "A", "lanes": [{"lane": "kick", "steps": "x..............."}]}
            ],
            "arrangement": ["A"]
        }));
        let n = d.normalize(&DRUMS, 16).unwrap();
        assert_eq!(n.sections.len(), 1);
        let expected: MeasureNotes = [((row("kick"), 0), note(120, 1))].into_iter().collect();
        assert_eq!(n.sections[0], expected);
    }

    #[test]
    fn tempo_swing_and_name_are_clamped() {
        let d = draft(json!({
            "name": "   ",
            "tempo_bpm": 400.0,
            "swing": 2.0,
            "sections": [{"id": "A", "lanes": [{"lane": "kick", "steps": "x"}]}],
            "arrangement": []
        }));
        let n = d.normalize(&DRUMS, 16).unwrap();
        assert_eq!(n.tempo_bpm, Some(240));
        assert_eq!(n.swing, Some(0.75));
        assert_eq!(n.name, FALLBACK_NAME);
        assert_eq!(n.arrangement, vec![0]);
    }

    #[test]
    fn unknown_arrangement_entries_are_skipped() {
        let d = draft(json!({
            "name": "Arr",
            "sections": [
                {"id": "A", "lanes": [{"lane": "kick", "steps": "x"}]},
                {"id": "fill", "lanes": [{"lane": "snare", "steps": "xxxx"}]}
            ],
            "arrangement": ["A", "B", "A", "fill"]
        }));
        assert_eq!(d.normalize(&DRUMS, 16).unwrap().arrangement, vec![0, 0, 1]);
    }

    mod melodic {
        use super::*;
        use crate::instruments::piano::PIANO;

        fn piano_row(id: &str) -> usize {
            PIANO.rows.iter().position(|r| r.id == id).unwrap()
        }

        fn lane_rows(lanes: &[(&str, &str)]) -> MeasureNotes {
            let lanes: Vec<_> = lanes
                .iter()
                .map(|(lane, steps)| json!({"lane": lane, "steps": steps}))
                .collect();
            draft(json!({
                "name": "P",
                "sections": [{"id": "A", "lanes": lanes}],
                "arrangement": ["A"]
            }))
            .normalize(&PIANO, 16)
            .unwrap()
            .sections
            .remove(0)
        }

        #[test]
        fn flats_and_midi_numbers_resolve_to_sharp_rows() {
            let notes = lane_rows(&[("Bb3", "x..."), ("60", ".x..")]);
            let expected: MeasureNotes = [
                ((piano_row("A#3"), 0), note(90, 1)),
                ((piano_row("C4"), 1), note(90, 1)),
            ]
            .into_iter()
            .collect();
            assert_eq!(notes, expected);
        }

        #[test]
        fn out_of_range_pitches_fold_by_octaves() {
            let notes = lane_rows(&[("E8", "x---")]);
            let expected: MeasureNotes =
                [((piano_row("E6"), 0), note(90, 4))].into_iter().collect();
            assert_eq!(notes, expected);
        }

        #[test]
        fn drum_lanes_are_dropped() {
            let notes = lane_rows(&[("kick", "xxxx"), ("C4", "x...")]);
            assert_eq!(notes.len(), 1);
        }

        #[test]
        fn lanes_folding_onto_one_row_keep_the_louder_note() {
            let notes = lane_rows(&[("C7", "g..."), ("C8", "X..."), ("C9", "x...")]);
            let expected: MeasureNotes =
                [((piano_row("C7"), 0), note(120, 1))].into_iter().collect();
            assert_eq!(notes, expected);
        }
    }

    #[test]
    fn empty_drafts_are_errors() {
        let none = draft(json!({"name": "x", "sections": [], "arrangement": []}));
        assert_eq!(none.normalize(&DRUMS, 16), Err(DraftError::NoSections));
        assert_eq!(
            single_lane("kick", json!("....")).normalize(&DRUMS, 16),
            Err(DraftError::NoNotes)
        );
        assert!(matches!(
            PatternDraft::from_json(json!({"name": 3})),
            Err(DraftError::Parse(_))
        ));
    }
}
