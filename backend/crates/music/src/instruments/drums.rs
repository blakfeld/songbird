use crate::draft::{MeasureNotes, SectionNote};

use super::{ExampleDraft, Instrument, InstrumentKind, RowDef};

const fn row(id: &'static str, name: &'static str, midi_note: u8) -> RowDef {
    RowDef {
        id,
        name,
        midi_note,
    }
}

/// Every drums pattern carries all rows, even silent ones, so the editor can
/// add any sound to a generated pattern.
static ROWS: [RowDef; 12] = [
    row("kick", "Kick", 36),
    row("snare", "Snare", 38),
    row("rim", "Side Stick", 37),
    row("clap", "Clap", 39),
    row("hat_closed", "Closed Hi-Hat", 42),
    row("hat_pedal", "Pedal Hi-Hat", 44),
    row("hat_open", "Open Hi-Hat", 46),
    row("tom_low", "Low Tom", 45),
    row("tom_mid", "Mid Tom", 47),
    row("tom_high", "High Tom", 50),
    row("crash", "Crash", 49),
    row("ride", "Ride", 51),
];

const ALIASES: [(&str, &str); 25] = [
    ("bd", "kick"),
    ("kick_drum", "kick"),
    ("bass_drum", "kick"),
    ("sd", "snare"),
    ("snare_drum", "snare"),
    ("side_stick", "rim"),
    ("sidestick", "rim"),
    ("rimshot", "rim"),
    ("rim_shot", "rim"),
    ("rs", "rim"),
    ("handclap", "clap"),
    ("hand_clap", "clap"),
    ("cp", "clap"),
    ("hh", "hat_closed"),
    ("hihat", "hat_closed"),
    ("hi_hat", "hat_closed"),
    ("closed_hat", "hat_closed"),
    ("closed_hihat", "hat_closed"),
    ("closed_hi_hat", "hat_closed"),
    ("ch", "hat_closed"),
    ("hat", "hat_closed"),
    ("pedal_hat", "hat_pedal"),
    ("pedal_hihat", "hat_pedal"),
    ("open_hat", "hat_open"),
    ("oh", "hat_open"),
];

/// A drum groove needs concrete kit vocabulary in the prompt because models
/// otherwise invent row names or write melodic parts.
const SYSTEM_PROMPT: &str = "\
The instrument is a drum kit. Use only these lanes: kick, snare, rim (side stick), clap, \
hat_closed, hat_pedal, hat_open, tom_low, tom_mid, tom_high, crash, ride.\n\
Genre conventions: rock puts kick on 1 and 3 with snare backbeat on 2 and 4 and eighth-note \
hats; house is four-on-the-floor kick with off-beat open hats and claps on 2 and 4; boom bap is \
a syncopated kick with a hard snare on 2 and 4, swung sixteenth hats, and light ghost snares; \
trap uses sparse kicks, snare or clap on beat 3, fast hi-hat rolls with ghost and accent \
dynamics, and open-hat accents.\n\
Use crash on the first beat after a fill and toms or snare rolls for fills. Vary dynamics with \
'g' ghost notes and 'X' accents rather than playing every hit at one volume.";

const ROCK: &str = r#"{
  "name": "Straight Rock", "tempo_bpm": 110, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "kick", "steps": "x.......x.x....."},
      {"lane": "snare", "steps": "....X.......X..."},
      {"lane": "hat_closed", "steps": "x.x.x.x.x.x.x.x."}]},
    {"id": "fill", "lanes": [
      {"lane": "kick", "steps": "x.......x......."},
      {"lane": "snare", "steps": "....X.......xxXX"},
      {"lane": "tom_high", "steps": "........xx......"},
      {"lane": "crash", "steps": "x---------------"}]}
  ],
  "arrangement": ["A", "A", "A", "fill"]
}"#;

const HOUSE: &str = r#"{
  "name": "Four On The Floor", "tempo_bpm": 124, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "kick", "steps": "x...x...x...x..."},
      {"lane": "clap", "steps": "....x.......x..."},
      {"lane": "hat_open", "steps": "..x...x...x...x."},
      {"lane": "hat_closed", "steps": "xgxgxgxgxgxgxgxg"}]},
    {"id": "fill", "lanes": [
      {"lane": "kick", "steps": "x...x...x...x..."},
      {"lane": "clap", "steps": "....x.......xxxx"},
      {"lane": "hat_closed", "steps": "xgxgxgxgxgxg...."}]}
  ],
  "arrangement": ["A", "A", "A", "fill"]
}"#;

const BOOM_BAP: &str = r#"{
  "name": "Dusty Boom Bap", "tempo_bpm": 90, "swing": 0.2,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "kick", "steps": "x......x..x....."},
      {"lane": "snare", "steps": "....X.g.....X..g"},
      {"lane": "hat_closed", "steps": "x.x.x.x.x.x.x.x."}]},
    {"id": "fill", "lanes": [
      {"lane": "kick", "steps": "x......x........"},
      {"lane": "snare", "steps": "....X.....xxXXXX"},
      {"lane": "crash", "steps": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}]}
  ],
  "arrangement": ["A", "A", "A", "fill"]
}"#;

const TRAP: &str = r#"{
  "name": "Trap Bounce", "tempo_bpm": 140, "swing": 0,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "kick", "steps": "x.....x...x....."},
      {"lane": "clap", "steps": "........x......."},
      {"lane": "hat_closed", "steps": "xgXgxgxgxgXgxxxx"},
      {"lane": "hat_open", "steps": "......x-......x-"}]},
    {"id": "fill", "lanes": [
      {"lane": "kick", "steps": "x.....x........."},
      {"lane": "clap", "steps": "........x......."},
      {"lane": "hat_closed", "steps": "xgXgxgxgxxxxxxxx"},
      {"lane": "snare", "steps": "............gxXX"}]}
  ],
  "arrangement": ["A", "A", "A", "fill"]
}"#;

static EXAMPLES: [ExampleDraft; 4] = [
    ExampleDraft {
        genre: "rock",
        keywords: &["rock", "punk", "metal", "indie", "backbeat"],
        json: ROCK,
    },
    ExampleDraft {
        genre: "house",
        keywords: &[
            "house",
            "techno",
            "disco",
            "edm",
            "four on the floor",
            "dance",
        ],
        json: HOUSE,
    },
    ExampleDraft {
        genre: "boom-bap",
        keywords: &[
            "boom bap", "boom-bap", "hip hop", "hip-hop", "lofi", "lo-fi",
        ],
        json: BOOM_BAP,
    },
    ExampleDraft {
        genre: "trap",
        keywords: &["trap", "drill", "rap"],
        json: TRAP,
    },
];

/// A snare roll is the conventional drum fill; it replaces the last quarter of
/// the groove so the pattern still lands on the next downbeat.
fn snare_roll_fill(primary: &MeasureNotes, steps_per_measure: u32) -> MeasureNotes {
    let roll_start = steps_per_measure - 4;
    let snare = row_index("snare");
    let mut fill: MeasureNotes = primary
        .iter()
        .filter(|((_, step), _)| *step < roll_start)
        .map(|(k, v)| (*k, *v))
        .collect();
    for (i, velocity) in [70u8, 85, 100, 115].into_iter().enumerate() {
        fill.insert(
            (snare, roll_start + i as u32),
            SectionNote {
                velocity,
                length: 1,
            },
        );
    }
    if fill == *primary {
        // The groove already ends in this exact roll, so a crash toggle is
        // the smallest change that still differs from the primary.
        let crash = row_index("crash");
        if fill.remove(&(crash, 0)).is_none() {
            fill.insert(
                (crash, 0),
                SectionNote {
                    velocity: 110,
                    length: 1,
                },
            );
        }
    }
    fill
}

fn row_index(id: &str) -> usize {
    ROWS.iter()
        .position(|r| r.id == id)
        .expect("drums row exists")
}

pub static DRUMS: Instrument = Instrument {
    id: "drums",
    name: "Drums",
    kind: InstrumentKind::Drums,
    midi_channel: 10,
    midi_program: None,
    range: None,
    sustained: false,
    rows: &ROWS,
    system_prompt: SYSTEM_PROMPT,
    row_aliases: &ALIASES,
    examples: &EXAMPLES,
    fallback_variation: Some(snare_roll_fill),
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::InstrumentRegistry;

    #[test]
    fn rows_and_channel_match_spec() {
        let expected = [
            ("kick", 36),
            ("snare", 38),
            ("rim", 37),
            ("clap", 39),
            ("hat_closed", 42),
            ("hat_pedal", 44),
            ("hat_open", 46),
            ("tom_low", 45),
            ("tom_mid", 47),
            ("tom_high", 50),
            ("crash", 49),
            ("ride", 51),
        ];
        let actual: Vec<_> = DRUMS.rows.iter().map(|r| (r.id, r.midi_note)).collect();
        assert_eq!(actual, expected);
        assert_eq!(DRUMS.midi_channel, 10);
        assert!(!DRUMS.sustained);
        assert!(InstrumentRegistry::builtin().get("drums").is_some());
    }

    #[test]
    fn aliases_resolve_to_rows() {
        let id = |raw: &str| DRUMS.resolve_row(raw).map(|i| DRUMS.rows[i].id);
        assert_eq!(id("bd"), Some("kick"));
        assert_eq!(id("hh"), Some("hat_closed"));
        assert_eq!(id("OH"), Some("hat_open"));
        assert_eq!(id("Hi-Hat"), Some("hat_closed"));
        assert_eq!(id("ride"), Some("ride"));
        assert_eq!(id("cowbell"), None);
        assert!(ALIASES
            .iter()
            .all(|(_, row)| DRUMS.row_index(row).is_some()));
    }

    #[test]
    fn ships_four_example_drafts_that_normalize() {
        let genres: Vec<_> = DRUMS.examples.iter().map(|e| e.genre).collect();
        assert_eq!(genres, ["rock", "house", "boom-bap", "trap"]);
        for example in DRUMS.examples {
            for spm in [12, 16] {
                let normalized = example.draft().normalize(&DRUMS, spm).unwrap();
                assert!(normalized.sections.iter().any(|s| !s.is_empty()));
            }
        }
    }

    #[test]
    fn fallback_hook_always_differs_from_primary() {
        let hook = DRUMS.fallback_variation.unwrap();
        for spm in [12, 16] {
            for example in DRUMS.examples {
                let n = example.draft().normalize(&DRUMS, spm).unwrap();
                for section in &n.sections {
                    assert_ne!(&hook(section, spm), section);
                }
            }
            assert_ne!(hook(&MeasureNotes::new(), spm), MeasureNotes::new());
        }
    }
}
