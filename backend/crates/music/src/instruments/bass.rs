use std::sync::LazyLock;

use super::melodic::melodic;
use super::pitch::pitch_rows;
use super::{ExampleDraft, Instrument, Monophony, RowDef};

const LOW: u8 = 28;
const HIGH: u8 = 55;

/// Built once because names are computed; see `pitch_rows`.
static ROWS: LazyLock<Vec<RowDef>> = LazyLock::new(|| pitch_rows(LOW, HIGH));

/// Models invent out-of-range or flat spellings unless shown the exact
/// vocabulary, and stack notes unless told the role of the part.
const SYSTEM_PROMPT: &str = "\
The instrument is a bass guitar playing a bassline: root-driven, mostly one note at a time, \
locking with a kick drum. Each lane is one pitch, named in scientific pitch notation with \
sharps (E1, F1, F#1 ... F#3, G3); the range is E1 to G3. Use only pitches from that range.\n\
Write a single line: never put two lanes on the same step, and make a hold ('-') end before the \
next note begins. Prefer roots and fifths on strong beats, with passing tones and octave jumps \
for movement, and rests so the line leaves room for the drums.\n\
Stay low (E1 to G2) for most of the part. Accent downbeats with 'X' and soften ghost notes with \
'g'. Reuse sections for repeated measures instead of writing every measure out.";

const ROCK: &str = r#"{
  "name": "Driving Eighths", "tempo_bpm": 120, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C2", "steps": "x-x-x-x-x-x-x-x-"}]},
    {"id": "G", "lanes": [
      {"lane": "G1", "steps": "x-x-x-x-x-x-x-x-"}]},
    {"id": "Am", "lanes": [
      {"lane": "A1", "steps": "x-x-x-x-x-x-x-x-"}]},
    {"id": "F", "lanes": [
      {"lane": "F1", "steps": "x-x-x-x-x-x-x-x-"}]}
  ],
  "arrangement": ["C", "G", "Am", "F"]
}"#;

const FUNK: &str = r#"{
  "name": "Funk Groove", "tempo_bpm": 100, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "E1", "steps": "x--.....x-......"},
      {"lane": "E2", "steps": "...x.......x...."},
      {"lane": "G1", "steps": "......x-.....g.."}]},
    {"id": "B", "lanes": [
      {"lane": "A1", "steps": "x--.....x-......"},
      {"lane": "A2", "steps": "...x.......x...."},
      {"lane": "C2", "steps": "......x-.....g.."}]}
  ],
  "arrangement": ["A", "A", "B", "A"]
}"#;

const WALKING: &str = r#"{
  "name": "Walking Line", "tempo_bpm": 130, "swing": 0.3,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C2", "steps": "x---............"},
      {"lane": "E2", "steps": "....x---........"},
      {"lane": "G2", "steps": "........x---...."},
      {"lane": "A2", "steps": "............x---"}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x---............"},
      {"lane": "A2", "steps": "....x---........"},
      {"lane": "C3", "steps": "........x---...."},
      {"lane": "D3", "steps": "............x---"}]},
    {"id": "G", "lanes": [
      {"lane": "G1", "steps": "x---............"},
      {"lane": "B1", "steps": "....x---........"},
      {"lane": "D2", "steps": "........x---...."},
      {"lane": "E2", "steps": "............x---"}]}
  ],
  "arrangement": ["C", "F", "C", "G"]
}"#;

const SUSTAINED: &str = r#"{
  "name": "Root Notes", "tempo_bpm": 70, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C2", "steps": "x---------------"}]},
    {"id": "A", "lanes": [
      {"lane": "A1", "steps": "x---------------"}]},
    {"id": "F", "lanes": [
      {"lane": "F1", "steps": "x---------------"}]},
    {"id": "G", "lanes": [
      {"lane": "G1", "steps": "x---------------"}]}
  ],
  "arrangement": ["C", "A", "F", "G"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "rock",
        keywords: &["rock", "driving", "eighth", "punk", "root", "pop"],
        json: ROCK,
    },
    ExampleDraft {
        genre: "funk",
        keywords: &["funk", "groove", "syncopated", "disco", "slap", "upbeat"],
        json: FUNK,
    },
    ExampleDraft {
        genre: "walking",
        keywords: &["walking", "jazz", "swing", "blues", "upright", "quarter"],
        json: WALKING,
    },
    ExampleDraft {
        genre: "sustained",
        keywords: &[
            "sustained",
            "slow",
            "ballad",
            "ambient",
            "whole note",
            "drone",
            "sub",
        ],
        json: SUSTAINED,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static BASS: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "bass",
        "Bass",
        34,
        ROWS.as_slice(),
        SYSTEM_PROMPT,
        &EXAMPLES,
    )
    .with_monophony(Monophony::KeepLowest)
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::melodic::{
        assert_definition, assert_examples_are_monophonic, assert_examples_are_usable,
    };

    #[test]
    fn definition_matches_spec() {
        assert_definition(&BASS, ("bass", "Bass", 34), (28, 55));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = BASS.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["rock", "funk", "walking", "sustained"]);
        assert_examples_are_usable(&BASS);
    }

    #[test]
    fn rows_run_from_g3_down_to_e1() {
        assert_eq!(BASS.rows.len(), 28);
        assert_eq!(BASS.rows[0].id, "G3");
        assert_eq!(BASS.rows[27].id, "E1");
        assert_eq!(BASS.monophony, Monophony::KeepLowest);
    }

    #[test]
    fn examples_are_single_lines() {
        assert_examples_are_monophonic(&BASS);
    }
}
