use std::sync::LazyLock;

use super::melodic::melodic;
use super::pitch::pitch_rows;
use super::{ExampleDraft, Instrument, RowDef};

const LOW: u8 = 36;
const HIGH: u8 = 96;

/// Built once because names are computed; see `pitch_rows`.
static ROWS: LazyLock<Vec<RowDef>> = LazyLock::new(|| pitch_rows(LOW, HIGH));

/// Models tend to write single-note melodies unless told that chords are
/// several lanes, and to invent out-of-range or flat spellings unless shown the
/// exact vocabulary.
const SYSTEM_PROMPT: &str = "\
The instrument is a piano. Each lane is one pitch, named in scientific pitch notation with \
sharps (C2, C#2, D2 ... B6, C7); middle C is C4 and the range is C2 to C7. Use only pitches \
from that range.\n\
Write a chord as several lanes that share the same steps. Write a melody as one lane per \
distinct pitch, each with its own steps. Use holds ('-') for sustained notes: a whole-note \
chord is 'x' followed by fifteen '-' in a 4/4 measure.\n\
Keep the left hand low (C2 to B3) and the right hand in the middle (C4 to C6). Vary velocity \
with 'g' and 'X' so the part breathes. Reuse sections for repeated measures instead of \
writing every measure out.";

const BALLAD: &str = r#"{
  "name": "Slow Ballad", "tempo_bpm": 72, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"}]},
    {"id": "Am", "lanes": [
      {"lane": "A2", "steps": "x---------------"},
      {"lane": "A3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x---------------"},
      {"lane": "F3", "steps": "x---------------"},
      {"lane": "A3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"}]},
    {"id": "G", "lanes": [
      {"lane": "G2", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "B3", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"}]}
  ],
  "arrangement": ["C", "Am", "F", "G"]
}"#;

const POP: &str = r#"{
  "name": "Pop Chords", "tempo_bpm": 110, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C3", "steps": "x-----x---x-----"},
      {"lane": "C4", "steps": "x--x--x---x-x---"},
      {"lane": "E4", "steps": "x--x--x---x-x---"},
      {"lane": "G4", "steps": "x--x--x---x-x---"},
      {"lane": "E5", "steps": "..x---..X---.g.."}]},
    {"id": "G", "lanes": [
      {"lane": "G2", "steps": "x-----x---x-----"},
      {"lane": "B3", "steps": "x--x--x---x-x---"},
      {"lane": "D4", "steps": "x--x--x---x-x---"},
      {"lane": "G4", "steps": "x--x--x---x-x---"},
      {"lane": "D5", "steps": "..x---..X---.g.."}]}
  ],
  "arrangement": ["C", "G", "C", "G"]
}"#;

const JAZZ: &str = r#"{
  "name": "Shell Voicings", "tempo_bpm": 120, "swing": 0.3,
  "sections": [
    {"id": "Dm7", "lanes": [
      {"lane": "D3", "steps": "x-----..x-......"},
      {"lane": "C4", "steps": "..x---..x-......"},
      {"lane": "F4", "steps": "..x---..x-......"}]},
    {"id": "G7", "lanes": [
      {"lane": "G2", "steps": "x-----..x-......"},
      {"lane": "F3", "steps": "..x---..x-......"},
      {"lane": "B3", "steps": "..x---..x-......"}]},
    {"id": "Cmaj7", "lanes": [
      {"lane": "C3", "steps": "x-----..x-......"},
      {"lane": "B3", "steps": "..x---..x-......"},
      {"lane": "E4", "steps": "..x---..x-......"}]},
    {"id": "A7", "lanes": [
      {"lane": "A2", "steps": "x-----..x-......"},
      {"lane": "G3", "steps": "..x---..x-......"},
      {"lane": "Db4", "steps": "..x---..x-......"}]}
  ],
  "arrangement": ["Dm7", "G7", "Cmaj7", "A7"]
}"#;

const ARPEGGIO: &str = r#"{
  "name": "Broken Chords", "tempo_bpm": 96, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C2", "steps": "x---------------"},
      {"lane": "C4", "steps": "x-......x-......"},
      {"lane": "E4", "steps": "..x-..x-..x-..x-"},
      {"lane": "G4", "steps": "....x-......x-.."}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x---------------"},
      {"lane": "F3", "steps": "x-......x-......"},
      {"lane": "A3", "steps": "..x-..x-..x-..x-"},
      {"lane": "C4", "steps": "....x-......x-.."}]}
  ],
  "arrangement": ["C", "F", "C", "F"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "ballad",
        keywords: &["ballad", "slow", "romantic", "sad", "gentle", "whole note"],
        json: BALLAD,
    },
    ExampleDraft {
        genre: "pop",
        keywords: &["pop", "upbeat", "catchy", "happy", "syncopated"],
        json: POP,
    },
    ExampleDraft {
        genre: "jazz",
        keywords: &["jazz", "blues", "swing", "shell", "voicing"],
        json: JAZZ,
    },
    ExampleDraft {
        genre: "arpeggio",
        keywords: &["arpeggio", "broken chord", "classical", "flowing", "etude"],
        json: ARPEGGIO,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static PIANO: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "piano",
        "Piano",
        1,
        ROWS.as_slice(),
        SYSTEM_PROMPT,
        &EXAMPLES,
    )
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::{InstrumentKind, InstrumentRegistry, PitchRange};

    #[test]
    fn definition_matches_spec() {
        assert_eq!(PIANO.id, "piano");
        assert_eq!(PIANO.name, "Piano");
        assert_eq!(PIANO.kind, InstrumentKind::Melodic);
        assert_eq!(PIANO.midi_channel, 1);
        assert_eq!(PIANO.midi_program, Some(1));
        assert_eq!(PIANO.range, Some(PitchRange { low: 36, high: 96 }));
        assert!(PIANO.sustained);
        assert_eq!(PIANO.rows.len(), 61);
        assert_eq!(PIANO.rows[0].id, "C7");
        assert_eq!(PIANO.rows[60].id, "C2");
        assert_eq!(
            PIANO.rows.iter().find(|r| r.midi_note == 61).unwrap().name,
            "C#4"
        );
        assert!(InstrumentRegistry::builtin().get("piano").is_some());
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = PIANO.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["ballad", "pop", "jazz", "arpeggio"]);
        for example in PIANO.examples {
            let draft = example.draft();
            for section in &draft.sections {
                for lane in &section.lanes {
                    let pitch = crate::instruments::pitch::parse_pitch(&lane.lane).unwrap();
                    assert!(
                        (36..=96).contains(&pitch),
                        "{} {}",
                        example.genre,
                        lane.lane
                    );
                }
            }
            for spm in [12, 16] {
                let normalized = draft.normalize(&PIANO, spm).unwrap();
                assert!(normalized.sections.iter().all(|s| !s.is_empty()));
            }
        }
    }

    #[test]
    fn fallback_hook_always_differs_from_primary() {
        let hook = PIANO.fallback_variation.unwrap();
        for spm in [12, 16] {
            for example in PIANO.examples {
                let n = example.draft().normalize(&PIANO, spm).unwrap();
                for section in &n.sections {
                    let variation = hook(section, spm);
                    assert_ne!(&variation, section);
                    assert!(variation.keys().all(|(row, _)| *row < PIANO.rows.len()));
                }
            }
        }
    }
}
