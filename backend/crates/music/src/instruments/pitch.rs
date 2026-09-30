use std::sync::LazyLock;

use super::RowDef;

const NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

pub fn pitch_name(midi: u8) -> String {
    let octave = i32::from(midi / 12) - 1;
    format!("{}{octave}", NAMES[usize::from(midi % 12)])
}

/// Models spell pitches many ways, so the parser is lenient; the schema only
/// ever offers sharps.
pub fn parse_pitch(raw: &str) -> Option<i32> {
    let raw = raw.trim();
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        return raw
            .parse::<u32>()
            .ok()
            .filter(|n| *n <= 127)
            .map(|n| n as i32);
    }

    let mut chars = raw.chars();
    let base = match chars.next()?.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    };
    let rest = chars.as_str();
    let (accidental, octave) = match rest.chars().next()? {
        '#' | '♯' => (1, &rest[rest.chars().next()?.len_utf8()..]),
        // The note letter is always first, so a b/B here can only be an accidental.
        'b' | 'B' | '♭' if rest.len() > 1 => (-1, &rest[rest.chars().next()?.len_utf8()..]),
        _ => (0, rest),
    };
    let digits = octave.strip_prefix('-').unwrap_or(octave);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let octave: i32 = octave.parse().ok()?;
    if !(-1..=9).contains(&octave) {
        return None;
    }
    let midi = (octave + 1) * 12 + base + accidental;
    (0..=127).contains(&midi).then_some(midi)
}

/// Static so row ids can be `&'static str` without leaking on every call.
static PITCH_NAMES: LazyLock<[String; 128]> =
    LazyLock::new(|| std::array::from_fn(|midi| pitch_name(midi as u8)));

/// Display order is high to low because that is how piano rolls read.
pub fn pitch_rows(low: u8, high: u8) -> Vec<RowDef> {
    (low..=high)
        .rev()
        .map(|midi| {
            let name = PITCH_NAMES[usize::from(midi)].as_str();
            RowDef {
                id: name,
                name,
                midi_note: midi,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_use_sharps_and_c4_is_60() {
        assert_eq!(pitch_name(60), "C4");
        assert_eq!(pitch_name(61), "C#4");
        assert_eq!(pitch_name(21), "A0");
        assert_eq!(pitch_name(0), "C-1");
        assert_eq!(pitch_name(127), "G9");
    }

    #[test]
    fn parses_flats_sharps_case_and_numbers() {
        for raw in ["Db4", "db4", "C#4", "c#4", "D♭4", "C♯4", "61"] {
            assert_eq!(parse_pitch(raw), Some(61), "{raw}");
        }
        assert_eq!(parse_pitch("C4"), Some(60));
        assert_eq!(parse_pitch("60"), Some(60));
        assert_eq!(parse_pitch(" Bb3 "), Some(58));
        assert_eq!(parse_pitch("B4"), Some(71));
        assert_eq!(parse_pitch("bb4"), Some(70));
        assert_eq!(parse_pitch("C-1"), Some(0));
        assert_eq!(parse_pitch("G9"), Some(127));
    }

    #[test]
    fn rejects_malformed_and_out_of_range_pitches() {
        for raw in [
            "H4", "C10", "128", "", "C", "C#", "b", "kick", "-5", "C+4", "G#9", "Cb-1",
        ] {
            assert_eq!(parse_pitch(raw), None, "{raw}");
        }
    }

    #[test]
    fn every_midi_note_round_trips_through_its_name() {
        for midi in 0..=127u8 {
            assert_eq!(parse_pitch(&pitch_name(midi)), Some(i32::from(midi)));
        }
    }

    #[test]
    fn rows_run_high_to_low() {
        let rows = pitch_rows(36, 96);
        assert_eq!(rows.len(), 61);
        assert_eq!((rows[0].id, rows[0].midi_note), ("C7", 96));
        assert_eq!((rows[60].id, rows[60].midi_note), ("C2", 36));
        assert!(rows.iter().all(|r| r.id == r.name));
    }
}
