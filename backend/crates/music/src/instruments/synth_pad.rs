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
The instrument is a synth pad: long held chords with few onsets that form a warm bed under \
other parts. Each lane is one pitch, named in scientific pitch notation with sharps (C2, C#2, D2 \
... B5, C6); middle C is C4 and the range is C2 to C6. Use only pitches from that range.\n\
Write a chord as several lanes that share the same steps. The tone attacks slowly and releases \
over a long tail, so use whole-measure or half-measure holds ('-'): a whole-note chord is 'x' \
followed by fifteen '-' in a 4/4 measure. Avoid busy rhythms.\n\
Use open voicings of three to five notes, with a low root (C2 to B2) and the rest in the middle \
(C3 to C5). Change chords slowly and keep velocity even, using 'g' for softer swells. Reuse \
sections for repeated measures instead of writing every measure out.";

const AMBIENT: &str = r#"{
  "name": "Floating Bed", "tempo_bpm": 60, "swing": 0,
  "sections": [
    {"id": "Cmaj7", "lanes": [
      {"lane": "C2", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "B3", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"}]},
    {"id": "Am9", "lanes": [
      {"lane": "A2", "steps": "x---------------"},
      {"lane": "E3", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "B3", "steps": "x---------------"}]},
    {"id": "Fmaj7", "lanes": [
      {"lane": "F2", "steps": "x---------------"},
      {"lane": "C3", "steps": "x---------------"},
      {"lane": "E3", "steps": "x---------------"},
      {"lane": "A3", "steps": "x---------------"}]},
    {"id": "Gsus", "lanes": [
      {"lane": "G2", "steps": "x---------------"},
      {"lane": "D3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"}]}
  ],
  "arrangement": ["Cmaj7", "Am9", "Fmaj7", "Gsus"]
}"#;

const CINEMATIC: &str = r#"{
  "name": "Dark Swell", "tempo_bpm": 68, "swing": 0,
  "sections": [
    {"id": "Cm", "lanes": [
      {"lane": "C2", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"},
      {"lane": "Eb4", "steps": "x---------------"}]},
    {"id": "Ab", "lanes": [
      {"lane": "Ab2", "steps": "x---------------"},
      {"lane": "Eb3", "steps": "x---------------"},
      {"lane": "Ab3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"}]},
    {"id": "Bb", "lanes": [
      {"lane": "Bb2", "steps": "x---------------"},
      {"lane": "F3", "steps": "x---------------"},
      {"lane": "Bb3", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"}]},
    {"id": "Gsus", "lanes": [
      {"lane": "G2", "steps": "x---------------"},
      {"lane": "D3", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "C4", "steps": "x---------------"}]}
  ],
  "arrangement": ["Cm", "Ab", "Bb", "Gsus"]
}"#;

const WARM: &str = r#"{
  "name": "Warm Chords", "tempo_bpm": 92, "swing": 0,
  "sections": [
    {"id": "C", "lanes": [
      {"lane": "C3", "steps": "x-------x-------"},
      {"lane": "G3", "steps": "x-------x-------"},
      {"lane": "C4", "steps": "x-------x-------"},
      {"lane": "E4", "steps": "x-------x-------"}]},
    {"id": "G", "lanes": [
      {"lane": "G2", "steps": "x-------x-------"},
      {"lane": "D3", "steps": "x-------x-------"},
      {"lane": "B3", "steps": "x-------x-------"},
      {"lane": "G4", "steps": "x-------x-------"}]},
    {"id": "Am", "lanes": [
      {"lane": "A2", "steps": "x-------x-------"},
      {"lane": "E3", "steps": "x-------x-------"},
      {"lane": "C4", "steps": "x-------x-------"},
      {"lane": "A4", "steps": "x-------x-------"}]},
    {"id": "F", "lanes": [
      {"lane": "F2", "steps": "x-------x-------"},
      {"lane": "C3", "steps": "x-------x-------"},
      {"lane": "A3", "steps": "x-------x-------"},
      {"lane": "F4", "steps": "x-------x-------"}]}
  ],
  "arrangement": ["C", "G", "Am", "F"]
}"#;

const EVOLVING: &str = r#"{
  "name": "Slow Motion", "tempo_bpm": 64, "swing": 0,
  "sections": [
    {"id": "Dm", "lanes": [
      {"lane": "D2", "steps": "x---------------"},
      {"lane": "A3", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"},
      {"lane": "F4", "steps": "x---------------"}]},
    {"id": "Dm2", "lanes": [
      {"lane": "D2", "steps": "x---------------"},
      {"lane": "A3", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "F4", "steps": "x---------------"}]},
    {"id": "Bb", "lanes": [
      {"lane": "Bb2", "steps": "x---------------"},
      {"lane": "F3", "steps": "x---------------"},
      {"lane": "D4", "steps": "x---------------"},
      {"lane": "F4", "steps": "x---------------"}]},
    {"id": "C", "lanes": [
      {"lane": "C2", "steps": "x---------------"},
      {"lane": "G3", "steps": "x---------------"},
      {"lane": "E4", "steps": "x---------------"},
      {"lane": "G4", "steps": "x---------------"}]}
  ],
  "arrangement": ["Dm", "Dm2", "Bb", "C"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "ambient",
        keywords: &[
            "ambient",
            "atmospheric",
            "space",
            "dreamy",
            "float",
            "drone",
        ],
        json: AMBIENT,
    },
    ExampleDraft {
        genre: "cinematic",
        keywords: &["cinematic", "epic", "film", "dark", "tension", "trailer"],
        json: CINEMATIC,
    },
    ExampleDraft {
        genre: "warm",
        keywords: &["warm", "pop", "lush", "chords", "happy", "bright"],
        json: WARM,
    },
    ExampleDraft {
        genre: "evolving",
        keywords: &["evolving", "slow", "ballad", "sad", "melancholy", "gentle"],
        json: EVOLVING,
    },
];

/// A `LazyLock` because the rows are computed, which a plain `static` cannot do.
pub static SYNTH_PAD: LazyLock<Instrument> = LazyLock::new(|| {
    melodic::<LOW, HIGH>(
        "synth-pad",
        "Synth Pad",
        89,
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
        assert_definition(&SYNTH_PAD, ("synth-pad", "Synth Pad", 89), (36, 84));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize_within_range() {
        let genres: Vec<_> = SYNTH_PAD.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["ambient", "cinematic", "warm", "evolving"]);
        assert_examples_are_usable(&SYNTH_PAD);
    }
}
