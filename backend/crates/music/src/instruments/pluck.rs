use std::sync::LazyLock;

use super::melodic::melodic;
use super::pitch::pitch_rows;
use super::{ExampleDraft, Instrument, RowDef};

const LOW: u8 = 48;
const HIGH: u8 = 84;

/// Built once because names are computed; see `pitch_rows`.
static ROWS: LazyLock<Vec<RowDef>> = LazyLock::new(|| pitch_rows(LOW, HIGH));

/// Models invent out-of-range or flat spellings unless shown the exact
/// vocabulary, and stack notes unless told the role of the part.
const SYSTEM_PROMPT: &str = "\
The instrument is a pluck: short, sharp notes that decay quickly, used for arpeggios, \
sequences, and rhythmic hooks. Each lane is one pitch, named in scientific pitch notation with \
sharps (C3, C#3, D3 ... B5, C6); middle C is C4 and the range is C3 to C6. Use only pitches \
from that range.\n\
Write notes as one or two steps rather than long holds, because they fade within about a \
second whatever their length. Write a pattern as one lane per distinct pitch, each with its own \
steps, and layer lanes on the same step only for occasional dyads.\n\
Stay in the middle of the range (C4 to C5) for clarity. Use 'X' for accents and 'g' for ghosted \
notes so a repeating figure has contour. Reuse sections for repeated measures instead of \
writing every measure out.";

const ARPEGGIO: &str = r#"{
  "name": "Plucked Arp", "tempo_bpm": 120, "swing": 0,
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
      {"lane": "A4", "steps": "...x...x...x...x"}]},
    {"id": "F", "lanes": [
      {"lane": "F3", "steps": "x...x...x...x..."},
      {"lane": "A3", "steps": ".x...x...x...x.."},
      {"lane": "C4", "steps": "..x...x...x...x."},
      {"lane": "F4", "steps": "...x...x...x...x"}]},
    {"id": "G", "lanes": [
      {"lane": "G3", "steps": "x...x...x...x..."},
      {"lane": "B3", "steps": ".x...x...x...x.."},
      {"lane": "D4", "steps": "..x...x...x...x."},
      {"lane": "G4", "steps": "...x...x...x...x"}]}
  ],
  "arrangement": ["C", "Am", "F", "G"]
}"#;

const PIZZICATO: &str = r#"{
  "name": "Playful Pizzicato", "tempo_bpm": 112, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "C4", "steps": "x.....x.....x..."},
      {"lane": "E4", "steps": "..x.....x......."},
      {"lane": "G4", "steps": "....x.....x.x..."}]},
    {"id": "B", "lanes": [
      {"lane": "D4", "steps": "x.....x.....x..."},
      {"lane": "F4", "steps": "..x.....x......."},
      {"lane": "A4", "steps": "....x.....x.x..."}]}
  ],
  "arrangement": ["A", "A", "B", "A"]
}"#;

const HOOK: &str = r#"{
  "name": "Pluck Hook", "tempo_bpm": 116, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "E4", "steps": "x--.x-.........."},
      {"lane": "G4", "steps": "....x-..x-......"},
      {"lane": "A4", "steps": "..x...........x-"},
      {"lane": "C5", "steps": "........x---...."}]},
    {"id": "B", "lanes": [
      {"lane": "D4", "steps": "x--.x-.........."},
      {"lane": "F4", "steps": "....x-..x-......"},
      {"lane": "G4", "steps": "..x...........x-"},
      {"lane": "B4", "steps": "........x---...."}]}
  ],
  "arrangement": ["A", "A", "B", "A"]
}"#;

const BOUNCE: &str = r#"{
  "name": "Offbeat Bounce", "tempo_bpm": 124, "swing": 0,
  "sections": [
    {"id": "Am", "lanes": [
      {"lane": "A3", "steps": "..x...x...x...x."},
      {"lane": "C4", "steps": "..x...x...x...x."},
      {"lane": "E4", "steps": "..x...x...x...x."}]},
    {"id": "F", "lanes": [
      {"lane": "F3", "steps": "..x...x...x...x."},
      {"lane": "A3", "steps": "..x...x...x...x."},
      {"lane": "C4", "steps": "..x...x...x...x."}]}
  ],
  "arrangement": ["Am", "F", "Am", "F"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "arpeggio",
        keywords: &["arpeggio", "arp", "sequence", "trance", "flowing", "pulse"],
        json: ARPEGGIO,
    },
    ExampleDraft {
        genre: "pizzicato",
        keywords: &[
            "pizzicato",
            "classical",
            "playful",
            "staccato",
            "light",
            "bouncy",
        ],
        json: PIZZICATO,
    },
    ExampleDraft {
        genre: "hook",
        keywords: &["hook", "pop", "catchy", "melody", "happy", "upbeat"],
        json: HOOK,
    },
    ExampleDraft {
        genre: "bounce",
        keywords: &["bounce", "house", "dance", "groove", "funk", "offbeat"],
        json: BOUNCE,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static PLUCK: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "pluck",
        "Pluck",
        46,
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
        assert_definition(&PLUCK, ("pluck", "Pluck", 46), (48, 84));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = PLUCK.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["arpeggio", "pizzicato", "hook", "bounce"]);
        assert_examples_are_usable(&PLUCK);
    }
}
