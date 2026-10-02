//! Sampler instruments are built in code rather than registered: they have no
//! generation prompt or examples, and keeping them out of the registry keeps
//! them out of `GET /api/v1/instruments` and every model-facing schema.

use std::sync::LazyLock;

use super::pitch::pitch_rows;
use super::{Instrument, InstrumentKind, Monophony, PitchRange, RowDef};

pub const KEYS_ID: &str = "sampler-keys";
pub const PADS_ID: &str = "sampler-pads";
pub const PAD_COUNT: usize = 16;

const KEYS_LOW: u8 = 24;
const KEYS_HIGH: u8 = 96;
const PAD_BASE_NOTE: u8 = 36;

static KEYS_ROWS: LazyLock<Vec<RowDef>> = LazyLock::new(|| pitch_rows(KEYS_LOW, KEYS_HIGH));

const fn pad(id: &'static str, name: &'static str, index: u8) -> RowDef {
    RowDef {
        id,
        name,
        midi_note: PAD_BASE_NOTE + index,
    }
}

/// Spelled out because row ids and names are `&'static str`.
static PAD_ROWS: [RowDef; PAD_COUNT] = [
    pad("pad-1", "Pad 1", 0),
    pad("pad-2", "Pad 2", 1),
    pad("pad-3", "Pad 3", 2),
    pad("pad-4", "Pad 4", 3),
    pad("pad-5", "Pad 5", 4),
    pad("pad-6", "Pad 6", 5),
    pad("pad-7", "Pad 7", 6),
    pad("pad-8", "Pad 8", 7),
    pad("pad-9", "Pad 9", 8),
    pad("pad-10", "Pad 10", 9),
    pad("pad-11", "Pad 11", 10),
    pad("pad-12", "Pad 12", 11),
    pad("pad-13", "Pad 13", 12),
    pad("pad-14", "Pad 14", 13),
    pad("pad-15", "Pad 15", 14),
    pad("pad-16", "Pad 16", 15),
];

/// The prompt, examples, and fallback are empty because generation refuses
/// sampler targets before an instrument is ever consulted.
pub static SAMPLER_KEYS: LazyLock<Instrument> = LazyLock::new(|| Instrument {
    id: KEYS_ID,
    name: "Sampler (keys)",
    kind: InstrumentKind::Melodic,
    midi_channel: 1,
    midi_program: None,
    range: Some(PitchRange {
        low: KEYS_LOW,
        high: KEYS_HIGH,
    }),
    sustained: true,
    rows: KEYS_ROWS.as_slice(),
    system_prompt: "",
    row_aliases: &[],
    examples: &[],
    fallback_variation: None,
    monophony: Monophony::None,
});

pub static SAMPLER_PADS: LazyLock<Instrument> = LazyLock::new(|| Instrument {
    id: PADS_ID,
    name: "Sampler (pads)",
    kind: InstrumentKind::Drums,
    midi_channel: 10,
    midi_program: None,
    range: None,
    sustained: false,
    rows: &PAD_ROWS,
    system_prompt: "",
    row_aliases: &[],
    examples: &[],
    fallback_variation: None,
    monophony: Monophony::None,
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_cover_c7_down_to_c1() {
        assert_eq!(SAMPLER_KEYS.rows.len(), 73);
        assert_eq!(SAMPLER_KEYS.rows[0].id, "C7");
        assert_eq!(SAMPLER_KEYS.rows[72].id, "C1");
        assert_eq!(SAMPLER_KEYS.kind, InstrumentKind::Melodic);
        assert!(SAMPLER_KEYS.sustained);
    }

    #[test]
    fn pads_map_to_notes_36_through_51() {
        assert_eq!(SAMPLER_PADS.rows.len(), 16);
        assert_eq!(SAMPLER_PADS.kind, InstrumentKind::Drums);
        assert!(!SAMPLER_PADS.sustained);
        for (i, row) in SAMPLER_PADS.rows.iter().enumerate() {
            assert_eq!(row.id, format!("pad-{}", i + 1));
            assert_eq!(row.name, format!("Pad {}", i + 1));
            assert_eq!(usize::from(row.midi_note), 36 + i);
        }
    }
}
