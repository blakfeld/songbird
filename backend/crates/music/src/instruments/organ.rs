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
The instrument is a drawbar organ. Each lane is one pitch, named in scientific pitch notation with \
sharps (C2, C#2, D2 ... B5, C6); middle C is C4 and the range is C2 to C6. Use only pitches \
from that range.\n\
Write a chord as several lanes that share the same steps. The tone holds at a constant level and \
has no decay, so sustained chords with long holds ('-') are idiomatic; short notes work for \
stabs and rhythmic pulses. Add a bass pedal on a low lane (C2 to B2) under the chords.\n\
Keep chord voicings in the middle (C3 to C5). Vary velocity with 'g' and 'X' sparingly because \
organs have no touch response, and reuse sections for repeated measures instead of writing \
every measure out.";

const GOSPEL: &str = r#"{
  "name": "Gospel Pads", "tempo_bpm": 80, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C2", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"},
      {"lane": "C5", "steps": "x---------------"}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x---------------"},
      {"lane": "F4", "steps": "x---------------"},
      {"lane": "A4", "steps": "x---------------"},
      {"lane": "C5", "steps": "x---------------"}]},
    {"id": "G", "lanes": [
      {"lane": "G2", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"},
      {"lane": "B4", "steps": "x---------------"}]},
    {"id": "Am", "lanes": [
      {"lane": "A2", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "A4", "steps": "x---------------"},
      {"lane": "C5", "steps": "x---------------"}]}
  ],
  "arrangement": ["C", "F", "G", "C"]
}"#;

const ROCK: &str = r#"{
  "name": "Rock Organ", "tempo_bpm": 120, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "A2", "steps": "x-------x-------"},
      {"lane": "E4", "steps": "x-------x-------"},
      {"lane": "A4", "steps": "x-------x-------"},
      {"lane": "C5", "steps": "x-------x-------"}]},
    {"id": "D", "lanes": [
      {"lane": "D2", "steps": "x-------x-------"},
      {"lane": "D4", "steps": "x-------x-------"},
      {"lane": "F#4", "steps": "x-------x-------"},
      {"lane": "A4", "steps": "x-------x-------"}]},
    {"id": "E", "lanes": [
      {"lane": "E2", "steps": "x-------x-------"},
      {"lane": "E4", "steps": "x-------x-------"},
      {"lane": "G#4", "steps": "x-------x-------"},
      {"lane": "B4", "steps": "x-------x-------"}]}
  ],
  "arrangement": ["A", "A", "D", "E"]
}"#;

const JAZZ: &str = r#"{
  "name": "Soul Jazz Comp", "tempo_bpm": 112, "swing": 0.3,
  "sections": [
    {"id": "C7", "lanes": [
      {"lane": "C3", "steps": "x-----..x-......"},
      {"lane": "E4", "steps": "..x---..x-......"},
      {"lane": "Bb4", "steps": "..x---..x-......"}]},
    {"id": "F7", "lanes": [
      {"lane": "F2", "steps": "x-----..x-......"},
      {"lane": "A3", "steps": "..x---..x-......"},
      {"lane": "Eb4", "steps": "..x---..x-......"}]},
    {"id": "G7", "lanes": [
      {"lane": "G2", "steps": "x-----..x-......"},
      {"lane": "B3", "steps": "..x---..x-......"},
      {"lane": "F4", "steps": "..x---..x-......"}]}
  ],
  "arrangement": ["C7", "C7", "F7", "G7"]
}"#;

const PULSE: &str = r#"{
  "name": "Organ Pulse", "tempo_bpm": 124, "swing": 0,
  "sections": [
    {"id": "Am", "lanes": [
      {"lane": "A2", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "E4", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "A4", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "C5", "steps": "x-x-x-x-x-x-x-x-"}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "C4", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "F4", "steps": "x-x-x-x-x-x-x-x-"},
      {"lane": "A4", "steps": "x-x-x-x-x-x-x-x-"}]}
  ],
  "arrangement": ["Am", "F", "Am", "F"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "gospel",
        keywords: &["gospel", "church", "soul", "praise", "hymn", "worship"],
        json: GOSPEL,
    },
    ExampleDraft {
        genre: "rock",
        keywords: &["rock", "classic", "60s", "70s", "psychedelic", "prog"],
        json: ROCK,
    },
    ExampleDraft {
        genre: "jazz",
        keywords: &["jazz", "blues", "shuffle", "swing", "lounge", "soul jazz"],
        json: JAZZ,
    },
    ExampleDraft {
        genre: "pulse",
        keywords: &["pulse", "pop", "upbeat", "driving", "eighth", "dance"],
        json: PULSE,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static ORGAN: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "organ",
        "Organ",
        17,
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
        assert_definition(&ORGAN, ("organ", "Organ", 17), (36, 84));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = ORGAN.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["gospel", "rock", "jazz", "pulse"]);
        assert_examples_are_usable(&ORGAN);
    }
}
