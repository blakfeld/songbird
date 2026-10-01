use std::sync::LazyLock;

use super::melodic::melodic;
use super::pitch::pitch_rows;
use super::{ExampleDraft, Instrument, RowDef};

const LOW: u8 = 36;
const HIGH: u8 = 84;

/// Built once because names are computed; see `pitch_rows`.
static ROWS: LazyLock<Vec<RowDef>> = LazyLock::new(|| pitch_rows(LOW, HIGH));

/// Models invent out-of-range or flat spellings unless shown the exact
/// vocabulary, and stack notes unless told the role of the part.
const SYSTEM_PROMPT: &str = "\
The instrument is a string ensemble. Each lane is one pitch, named in scientific pitch notation \
with sharps (C2, C#2, D2 ... B5, C6); middle C is C4 and the range is C2 to C6. Use only \
pitches from that range.\n\
Write chords as several lanes that share the same steps, and melodies as one lane per distinct \
pitch, each with its own steps. The tone is sustained with a moderate attack, so legato holds \
('-') suit pads and countermelodies, while short repeated notes give a driving ostinato.\n\
Spread voicings across registers: low strings (C2 to B2) for roots, violas and cellos in the \
middle (C3 to B4), and violins on top (C5 to C6). Vary velocity with 'g' and 'X' for swells. \
Reuse sections for repeated measures instead of writing every measure out.";

const CINEMATIC: &str = r#"{
  "name": "Sweeping Chords", "tempo_bpm": 76, "swing": 0,
  "sections": [
    {"id": "Am", "lanes": [
      {"lane": "A2", "steps": "x---------------"},
      {"lane": "E3", "steps": "x---------------"},
      {"lane": "A3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x---------------"},
      {"lane": "C3", "steps": "x---------------"},
      {"lane": "F3", "steps": "x---------------"},
      {"lane": "A3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"}]},
    {"id": "C", "lanes": [
      {"lane": "C2", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"}]},
    {"id": "G", "lanes": [
      {"lane": "G2", "steps": "x---------------"},
      {"lane": "D3", "steps": "x---------------"},
      {"lane": "B3", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"}]}
  ],
  "arrangement": ["Am", "F", "C", "G"]
}"#;

const OSTINATO: &str = r#"{
  "name": "Driving Ostinato", "tempo_bpm": 132, "swing": 0,
  "sections": [
    {"id": "Em", "lanes": [
      {"lane": "E3", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "B3", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "E4", "steps": "x-x-x-x-x-x-x-x-"}]},
    {"id": "C", "lanes": [
      {"lane": "C3", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "G3", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "C4", "steps": "x-x-x-x-x-x-x-x-"}]}
  ],
  "arrangement": ["Em", "Em", "C", "C"]
}"#;

const LEGATO: &str = r#"{
  "name": "Legato Line", "tempo_bpm": 66, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "C3", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "E4", "steps": "x-------........"},
      {"lane": "D4", "steps": "........x-------"}]},
    {"id": "B", "lanes": [
      {"lane": "A2", "steps": "x---------------"},
      {"lane": "E3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x-------........"},
      {"lane": "B3", "steps": "........x-------"}]}
  ],
  "arrangement": ["A", "B", "A", "B"]
}"#;

const MELODY: &str = r#"{
  "name": "Lyrical Theme", "tempo_bpm": 84, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "E5", "steps": "x-------........"},
      {"lane": "D5", "steps": "........x---...."},
      {"lane": "C5", "steps": "............x---"}]},
    {"id": "B", "lanes": [
      {"lane": "G5", "steps": "x-------........"},
      {"lane": "F5", "steps": "........x---...."},
      {"lane": "E5", "steps": "............x---"}]}
  ],
  "arrangement": ["A", "B", "A", "B"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "cinematic",
        keywords: &[
            "cinematic",
            "epic",
            "film",
            "orchestral",
            "sweeping",
            "emotional",
        ],
        json: CINEMATIC,
    },
    ExampleDraft {
        genre: "ostinato",
        keywords: &[
            "ostinato", "driving", "staccato", "rhythmic", "tension", "action",
        ],
        json: OSTINATO,
    },
    ExampleDraft {
        genre: "legato",
        keywords: &["legato", "ballad", "slow", "romantic", "gentle", "sad"],
        json: LEGATO,
    },
    ExampleDraft {
        genre: "melody",
        keywords: &[
            "melody",
            "countermelody",
            "violin",
            "lyrical",
            "theme",
            "solo",
        ],
        json: MELODY,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static STRINGS: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "strings",
        "Strings",
        49,
        ROWS.as_slice(),
        SYSTEM_PROMPT,
        &EXAMPLES,
    )
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::melodic::{assert_definition, assert_examples_are_usable};

    #[test]
    fn definition_matches_spec() {
        assert_definition(&STRINGS, ("strings", "Strings", 49), (36, 84));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = STRINGS.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["cinematic", "ostinato", "legato", "melody"]);
        assert_examples_are_usable(&STRINGS);
    }
}
