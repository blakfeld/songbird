use std::sync::LazyLock;

use super::melodic::melodic;
use super::pitch::pitch_rows;
use super::{ExampleDraft, Instrument, Monophony, RowDef};

const LOW: u8 = 48;
const HIGH: u8 = 84;

/// Built once because names are computed; see `pitch_rows`.
static ROWS: LazyLock<Vec<RowDef>> = LazyLock::new(|| pitch_rows(LOW, HIGH));

/// Models invent out-of-range or flat spellings unless shown the exact
/// vocabulary, and stack notes unless told the role of the part.
const SYSTEM_PROMPT: &str = "\
The instrument is a synth lead playing a single melodic line: bright, sustained, and \
memorable. Each lane is one pitch, named in scientific pitch notation with sharps (C3, C#3, D3 \
... B5, C6); middle C is C4 and the range is C3 to C6. Use only pitches from that range.\n\
Write one note at a time: never put two lanes on the same step, and make a hold ('-') end before \
the next note begins. Write the melody as one lane per distinct pitch, each with its own steps. \
Favour stepwise motion with a few leaps, repeat a short hook, and leave rests so phrases \
breathe.\n\
Sit mostly in the upper-middle range (C4 to C6). Accent peaks with 'X' and soften pickups with \
'g'. Reuse sections for repeated measures instead of writing every measure out.";

const POP: &str = r#"{
  "name": "Catchy Hook", "tempo_bpm": 118, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "E5", "steps": "x---......x-...."},
      {"lane": "G5", "steps": "....x---........"},
      {"lane": "D5", "steps": "........x-......"},
      {"lane": "C5", "steps": "............x-x-"}]},
    {"id": "B", "lanes": [
      {"lane": "A5", "steps": "x-..x-.........."},
      {"lane": "G5", "steps": "........x---...."},
      {"lane": "E5", "steps": "............x---"}]}
  ],
  "arrangement": ["A", "A", "B", "A"]
}"#;

const ARPEGGIO: &str = r#"{
  "name": "Arp Sequence", "tempo_bpm": 128, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C4", "steps": "x...x...x...x..."},
      {"lane": "E4", "steps": ".x...x...x...x.."},
      {"lane": "G4", "steps": "..x...x...x...x."},
      {"lane": "C5", "steps": "...x...x...x...x"}]},
    {"id": "Am", "lanes": [
      {"lane": "A3", "steps": "x...x...x...x..."},
      {"lane": "C4", "steps": ".x...x...x...x.."},
      {"lane": "E4", "steps": "..x...x...x...x."},
      {"lane": "A4", "steps": "...x...x...x...x"}]}
  ],
  "arrangement": ["C", "Am", "C", "Am"]
}"#;

const SOLO: &str = r#"{
  "name": "Pentatonic Solo", "tempo_bpm": 110, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "A4", "steps": "x-----.........."},
      {"lane": "C5", "steps": "......x-........"},
      {"lane": "D5", "steps": "........x-....x-"},
      {"lane": "E5", "steps": "..........x---.."}]},
    {"id": "B", "lanes": [
      {"lane": "E5", "steps": "x-----.........."},
      {"lane": "D5", "steps": "......x-........"},
      {"lane": "C5", "steps": "........x-......"},
      {"lane": "A4", "steps": "..........x---.."}]}
  ],
  "arrangement": ["A", "A", "B", "A"]
}"#;

const RIFF: &str = r#"{
  "name": "Retro Riff", "tempo_bpm": 108, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "E4", "steps": "x-x-....x-x-...."},
      {"lane": "G4", "steps": "....x-x-....x-x-"}]},
    {"id": "F", "lanes": [
      {"lane": "F4", "steps": "x-x-....x-x-...."},
      {"lane": "A4", "steps": "....x-x-....x-x-"}]}
  ],
  "arrangement": ["A", "A", "F", "A"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "pop",
        keywords: &["pop", "catchy", "melody", "hook", "happy", "upbeat"],
        json: POP,
    },
    ExampleDraft {
        genre: "arpeggio",
        keywords: &["arpeggio", "trance", "sequence", "16th", "pulse", "edm"],
        json: ARPEGGIO,
    },
    ExampleDraft {
        genre: "solo",
        keywords: &["solo", "blues", "lead line", "expressive", "guitar", "rock"],
        json: SOLO,
    },
    ExampleDraft {
        genre: "riff",
        keywords: &["synthwave", "retro", "80s", "riff", "staccato", "dark"],
        json: RIFF,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static SYNTH_LEAD: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "synth-lead",
        "Synth Lead",
        81,
        ROWS.as_slice(),
        SYSTEM_PROMPT,
        &EXAMPLES,
    )
    .with_monophony(Monophony::KeepHighest)
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::melodic::{
        assert_definition, assert_examples_are_monophonic, assert_examples_are_usable,
    };

    #[test]
    fn definition_matches_spec() {
        assert_definition(&SYNTH_LEAD, ("synth-lead", "Synth Lead", 81), (48, 84));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = SYNTH_LEAD.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["pop", "arpeggio", "solo", "riff"]);
        assert_examples_are_usable(&SYNTH_LEAD);
    }

    #[test]
    fn keeps_the_highest_note() {
        assert_eq!(SYNTH_LEAD.monophony, Monophony::KeepHighest);
    }

    #[test]
    fn examples_are_single_lines() {
        assert_examples_are_monophonic(&SYNTH_LEAD);
    }
}
