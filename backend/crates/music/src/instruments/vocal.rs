use std::sync::LazyLock;

use super::melodic::melodic;
use super::pitch::pitch_rows;
use super::{ExampleDraft, Instrument, Monophony, RowDef};

const LOW: u8 = 40;
const HIGH: u8 = 84;

/// Built once because names are computed; see `pitch_rows`.
static ROWS: LazyLock<Vec<RowDef>> = LazyLock::new(|| pitch_rows(LOW, HIGH));

/// A guide melody is only useful if a singer could perform it, so the prompt
/// asks for one note at a time, stepwise motion, and rests where a singer
/// would breathe.
const SYSTEM_PROMPT: &str = "\
The instrument is a vocal guide: a single sung melody that a singer could perform. Each lane is \
one pitch, named in scientific pitch notation with sharps (E2, F2, F#2 ... B5, C6); middle C is \
C4 and the range is E2 to C6. Use only pitches from that range.\n\
Write one note at a time: never put two lanes on the same step, and make a hold ('-') end before \
the next note begins. Write the melody as one lane per distinct pitch, each with its own steps. \
Favour stepwise motion with occasional small leaps, keep the line within about an octave and a \
half, and leave a rest at the end of each phrase so the singer can breathe.\n\
Sit mostly in the middle of the range (C3 to C5). Accent phrase peaks with 'X' and soften \
pickups with 'g'. Reuse sections for repeated measures instead of writing every measure out.";

const VERSE: &str = r#"{
  "name": "Verse Line", "tempo_bpm": 96, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "E4", "steps": "x---..x-....x---"},
      {"lane": "G4", "steps": "....x-.........."},
      {"lane": "D4", "steps": "........x-......"}]},
    {"id": "B", "lanes": [
      {"lane": "C4", "steps": "x---......x-...."},
      {"lane": "D4", "steps": "....x-x-........"},
      {"lane": "E4", "steps": "............x---"}]}
  ],
  "arrangement": ["A", "B", "A", "B"]
}"#;

const CHORUS: &str = r#"{
  "name": "Chorus Hook", "tempo_bpm": 110, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "G4", "steps": "x---....x-x-...."},
      {"lane": "A4", "steps": "....x-x-....x---"}]},
    {"id": "B", "lanes": [
      {"lane": "C5", "steps": "x-----.........."},
      {"lane": "A4", "steps": "......x-x-......"},
      {"lane": "G4", "steps": "............x---"}]}
  ],
  "arrangement": ["A", "A", "B", "A"]
}"#;

const LULLABY: &str = r#"{
  "name": "Slow Lullaby", "tempo_bpm": 72, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "E4", "steps": "x-------........"},
      {"lane": "D4", "steps": "........x-------"}]},
    {"id": "B", "lanes": [
      {"lane": "C4", "steps": "x-------........"},
      {"lane": "D4", "steps": "........x---...."},
      {"lane": "E4", "steps": "............x---"}]}
  ],
  "arrangement": ["A", "B", "A", "B"]
}"#;

const SOARING: &str = r#"{
  "name": "Soaring Line", "tempo_bpm": 100, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "C4", "steps": "x---............"},
      {"lane": "G4", "steps": "....x---........"},
      {"lane": "C5", "steps": "........x-------"}]},
    {"id": "B", "lanes": [
      {"lane": "D5", "steps": "x-------........"},
      {"lane": "B4", "steps": "........x---...."},
      {"lane": "G4", "steps": "............x---"}]}
  ],
  "arrangement": ["A", "B", "A", "B"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "verse",
        keywords: &[
            "verse",
            "story",
            "calm",
            "conversational",
            "stepwise",
            "melody",
        ],
        json: VERSE,
    },
    ExampleDraft {
        genre: "chorus",
        keywords: &["chorus", "hook", "catchy", "anthem", "pop", "upbeat"],
        json: CHORUS,
    },
    ExampleDraft {
        genre: "lullaby",
        keywords: &["lullaby", "slow", "gentle", "soft", "ballad", "sleepy"],
        json: LULLABY,
    },
    ExampleDraft {
        genre: "soaring",
        keywords: &["soaring", "big", "powerful", "leap", "belt", "dramatic"],
        json: SOARING,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static VOCAL: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "vocal",
        "Vocal Guide",
        54,
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
        assert_definition(&VOCAL, ("vocal", "Vocal Guide", 54), (40, 84));
    }

    #[test]
    fn has_forty_five_rows_from_c6_down_to_e2() {
        assert_eq!(VOCAL.rows.len(), 45);
        assert_eq!(VOCAL.rows.first().map(|r| r.name), Some("C6"));
        assert_eq!(VOCAL.rows.last().map(|r| r.name), Some("E2"));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = VOCAL.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["verse", "chorus", "lullaby", "soaring"]);
        assert_examples_are_usable(&VOCAL);
    }

    #[test]
    fn keeps_the_highest_note() {
        assert_eq!(VOCAL.monophony, Monophony::KeepHighest);
    }

    #[test]
    fn examples_are_single_lines() {
        assert_examples_are_monophonic(&VOCAL);
    }
}
