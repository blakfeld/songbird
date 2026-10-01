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
The instrument is an electric piano. Each lane is one pitch, named in scientific pitch notation with \
sharps (C2, C#2, D2 ... B5, C6); middle C is C4 and the range is C2 to C6. Use only pitches \
from that range.\n\
Write a chord as several lanes that share the same steps. Write a melody as one lane per \
distinct pitch, each with its own steps. The tone is bell-like and decays, so short stabs and \
syncopated comping suit it; use holds ('-') only for the notes that should ring.\n\
Keep roots low (C2 to B3) and voicings in the middle (C4 to C5), with seventh and ninth colours \
for soul and jazz. Vary velocity with 'g' and 'X' so the part breathes. Reuse sections for \
repeated measures instead of writing every measure out.";

const SOUL: &str = r#"{
  "name": "Neo-Soul Comp", "tempo_bpm": 88, "swing": 0.2,
  "sections": [
    {"id": "Dm9", "lanes": [
      {"lane": "D3", "steps": "x-----..x-......"},
      {"lane": "F4", "steps": "..x---..x-......"},
      {"lane": "A4", "steps": "..x---..x-......"},
      {"lane": "C5", "steps": "..x---..x-......"}]},
    {"id": "G13", "lanes": [
      {"lane": "G2", "steps": "x-----..x-......"},
      {"lane": "F4", "steps": "..x---..x-......"},
      {"lane": "B4", "steps": "..x---..x-......"},
      {"lane": "E5", "steps": "..x---..x-......"}]},
    {"id": "Cmaj9", "lanes": [
      {"lane": "C3", "steps": "x-----..x-......"},
      {"lane": "E4", "steps": "..x---..x-......"},
      {"lane": "B4", "steps": "..x---..x-......"},
      {"lane": "D5", "steps": "..x---..x-......"}]},
    {"id": "A7", "lanes": [
      {"lane": "A2", "steps": "x-----..x-......"},
      {"lane": "G4", "steps": "..x---..x-......"},
      {"lane": "C#5", "steps": "..x---..x-......"},
      {"lane": "E5", "steps": "..x---..x-......"}]}
  ],
  "arrangement": ["Dm9", "G13", "Cmaj9", "A7"]
}"#;

const BALLAD: &str = r#"{
  "name": "Tender Ballad", "tempo_bpm": 70, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C3", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"},
      {"lane": "B4", "steps": "x---------------"}]},
    {"id": "Am", "lanes": [
      {"lane": "A2", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"},
      {"lane": "C5", "steps": "x---------------"}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "A4", "steps": "x---------------"},
      {"lane": "C5", "steps": "x---------------"}]},
    {"id": "G", "lanes": [
      {"lane": "G2", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"},
      {"lane": "F4", "steps": "x---------------"},
      {"lane": "B4", "steps": "x---------------"}]}
  ],
  "arrangement": ["C", "Am", "F", "G"]
}"#;

const FUNK: &str = r#"{
  "name": "Funk Stabs", "tempo_bpm": 104, "swing": 0,
  "sections": [
    {"id": "Em7", "lanes": [
      {"lane": "E3", "steps": "x..x..x...x..x.."},
      {"lane": "G4", "steps": "x..x..x...x..x.."},
      {"lane": "B4", "steps": "x..x..x...x..x.."},
      {"lane": "D5", "steps": "x..x..x...x..x.."}]},
    {"id": "A7", "lanes": [
      {"lane": "A2", "steps": "x..x..x...x..x.."},
      {"lane": "G4", "steps": "x..x..x...x..x.."},
      {"lane": "C#5", "steps": "x..x..x...x..x.."},
      {"lane": "E5", "steps": "x..x..x...x..x.."}]}
  ],
  "arrangement": ["Em7", "Em7", "A7", "A7"]
}"#;

const LOFI: &str = r#"{
  "name": "Lo-fi Keys", "tempo_bpm": 76, "swing": 0.15,
  "sections": [
    {"id": "Fmaj7", "lanes": [
      {"lane": "F3", "steps": "x-----.........."},
      {"lane": "A3", "steps": "..x---..x-......"},
      {"lane": "C4", "steps": "..x---..x-......"},
      {"lane": "E4", "steps": "..x---..x-......"}]},
    {"id": "Em7", "lanes": [
      {"lane": "E3", "steps": "x-----.........."},
      {"lane": "G3", "steps": "..x---..x-......"},
      {"lane": "B3", "steps": "..x---..x-......"},
      {"lane": "D4", "steps": "..x---..x-......"}]}
  ],
  "arrangement": ["Fmaj7", "Em7", "Fmaj7", "Em7"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "soul",
        keywords: &["soul", "neo", "rnb", "r&b", "smooth", "groove"],
        json: SOUL,
    },
    ExampleDraft {
        genre: "ballad",
        keywords: &[
            "ballad",
            "slow",
            "romantic",
            "gentle",
            "tender",
            "whole note",
        ],
        json: BALLAD,
    },
    ExampleDraft {
        genre: "funk",
        keywords: &["funk", "stab", "disco", "upbeat", "syncopated", "dance"],
        json: FUNK,
    },
    ExampleDraft {
        genre: "lofi",
        keywords: &["lofi", "lo-fi", "chill", "mellow", "study", "dreamy"],
        json: LOFI,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static ELECTRIC_PIANO: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "electric-piano",
        "Electric Piano",
        5,
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
        assert_definition(
            &ELECTRIC_PIANO,
            ("electric-piano", "Electric Piano", 5),
            (36, 84),
        );
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = ELECTRIC_PIANO.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["soul", "ballad", "funk", "lofi"]);
        assert_examples_are_usable(&ELECTRIC_PIANO);
    }
}
