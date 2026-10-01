use crate::draft::{MeasureNotes, SectionNote};

use super::{ExampleDraft, Instrument, InstrumentKind, Monophony, PitchRange, RowDef};

/// Const generics carry the range because the fallback hook is a bare `fn`
/// pointer with no instrument to ask for its row count.
fn phrase_end<const LOW: u8, const HIGH: u8>(
    primary: &MeasureNotes,
    steps_per_measure: u32,
) -> MeasureNotes {
    melodic_phrase_end(usize::from(HIGH - LOW) + 1, primary, steps_per_measure)
}

/// Every melodic instrument is a sustained, channel-1 pitch grid that differs
/// only in data, so this is the one place those shared fields are decided.
pub fn melodic<const LOW: u8, const HIGH: u8>(
    id: &'static str,
    name: &'static str,
    midi_program: u8,
    rows: &'static [RowDef],
    system_prompt: &'static str,
    examples: &'static [ExampleDraft],
) -> Instrument {
    Instrument {
        id,
        name,
        kind: InstrumentKind::Melodic,
        midi_channel: 1,
        midi_program: Some(midi_program),
        range: Some(PitchRange {
            low: LOW,
            high: HIGH,
        }),
        sustained: true,
        rows,
        system_prompt,
        row_aliases: &[],
        examples,
        fallback_variation: Some(phrase_end::<LOW, HIGH>),
        monophony: Monophony::None,
    }
}

impl Instrument {
    pub fn with_monophony(mut self, monophony: Monophony) -> Self {
        self.monophony = monophony;
        self
    }
}

/// The hook type carries no instrument, so callers pass the row count. Rows run
/// high to low, so an octave up is twelve rows toward index 0.
///
/// The cadence keeps the first half and holds its last onset to the barline,
/// which sounds like a phrase settling without inventing new pitches.
pub fn melodic_phrase_end(
    row_count: usize,
    primary: &MeasureNotes,
    steps_per_measure: u32,
) -> MeasureNotes {
    let hold = |mut notes: MeasureNotes, from: u32| {
        for ((_, step), note) in notes.iter_mut() {
            if *step == from {
                note.length = steps_per_measure - from;
            }
        }
        notes
    };

    let first_half: MeasureNotes = primary
        .iter()
        .filter(|((_, step), _)| *step < steps_per_measure / 2)
        .map(|(k, v)| (*k, *v))
        .collect();
    let mut variation = match first_half.keys().map(|(_, step)| *step).max() {
        Some(last_onset) => hold(first_half, last_onset),
        None => {
            let Some(first_onset) = primary.keys().map(|(_, step)| *step).min() else {
                return MeasureNotes::new();
            };
            let moved: MeasureNotes = primary
                .iter()
                .filter(|((_, step), _)| *step == first_onset)
                .map(|(&(row, _), note)| ((row, 0), *note))
                .collect();
            hold(moved, 0)
        }
    };

    if variation == *primary {
        // A whole-measure chord is already its own cadence, so the top note
        // moves an octave, or is thinned when the range has no octave to spare.
        if let Some(&(row, step)) = variation.keys().min() {
            let mut note: SectionNote = variation.remove(&(row, step)).expect("key exists");
            let octave_row = if row >= 12 {
                Some(row - 12)
            } else if row + 12 < row_count {
                Some(row + 12)
            } else {
                None
            };
            match octave_row {
                Some(target) => {
                    variation.insert((target, step), note);
                }
                None if !variation.is_empty() => {}
                None if note.length > 1 => {
                    note.length /= 2;
                    variation.insert((row, step), note);
                }
                None => {
                    // A lone one-step note can only differ by moving.
                    let moved = if step == 0 { 1 } else { 0 };
                    variation.insert((row, moved), note);
                }
            }
        }
    }
    variation
}

/// Shared by every melodic module so each only states what is distinctive.
#[cfg(test)]
pub(crate) fn assert_definition(
    instrument: &Instrument,
    (id, name, program): (&str, &str, u8),
    (low, high): (u8, u8),
) {
    assert_eq!(instrument.id, id);
    assert_eq!(instrument.name, name);
    assert_eq!(instrument.kind, InstrumentKind::Melodic);
    assert_eq!(instrument.midi_channel, 1);
    assert_eq!(instrument.midi_program, Some(program));
    assert_eq!(instrument.range, Some(PitchRange { low, high }));
    assert!(instrument.sustained);
    assert_eq!(instrument.rows.len(), usize::from(high - low) + 1);
    assert_eq!(instrument.rows[0].midi_note, high);
    assert_eq!(instrument.rows.last().unwrap().midi_note, low);
}

#[cfg(test)]
pub(crate) fn assert_examples_are_usable(instrument: &Instrument) {
    assert_eq!(instrument.examples.len(), 4);
    let (low, high) = instrument.range.map(|r| (r.low, r.high)).unwrap();
    let hook = instrument.fallback_variation.unwrap();
    for example in instrument.examples {
        let draft = example.draft();
        for section in &draft.sections {
            for lane in &section.lanes {
                let pitch = super::pitch::parse_pitch(&lane.lane).unwrap();
                assert!(
                    (i32::from(low)..=i32::from(high)).contains(&pitch),
                    "{} {}",
                    example.genre,
                    lane.lane
                );
            }
        }
        for spm in [12, 16] {
            let normalized = draft.normalize(instrument, spm).unwrap();
            for section in &normalized.sections {
                assert!(!section.is_empty());
                let variation = hook(section, spm);
                assert_ne!(&variation, section, "{}", example.genre);
                assert!(variation
                    .keys()
                    .all(|(row, _)| *row < instrument.rows.len()));
            }
        }
    }
}

/// Bass and lead examples feed the mock provider, so they must already be
/// single lines rather than relying on the expander to repair them.
#[cfg(test)]
pub(crate) fn assert_examples_are_monophonic(instrument: &Instrument) {
    for example in instrument.examples {
        let normalized = example.draft().normalize(instrument, 16).unwrap();
        for section in &normalized.sections {
            let mut onsets: Vec<(u32, u32)> = section
                .iter()
                .map(|((_, step), n)| (*step, n.length))
                .collect();
            onsets.sort();
            for pair in onsets.windows(2) {
                assert!(
                    pair[0].0 + pair[0].1 <= pair[1].0,
                    "{} overlaps",
                    example.genre
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measure(notes: &[(usize, u32, u32)]) -> MeasureNotes {
        notes
            .iter()
            .map(|&(row, step, length)| {
                (
                    (row, step),
                    SectionNote {
                        velocity: 90,
                        length,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn last_first_half_onset_is_held_to_the_barline() {
        let primary = measure(&[(20, 0, 2), (24, 4, 2), (24, 12, 2)]);
        let variation = melodic_phrase_end(61, &primary, 16);
        assert_eq!(variation, measure(&[(20, 0, 2), (24, 4, 12)]));
    }

    #[test]
    fn late_only_phrase_moves_its_first_onset_to_step_zero() {
        let primary = measure(&[(20, 10, 1), (24, 10, 1), (22, 14, 1)]);
        let variation = melodic_phrase_end(61, &primary, 16);
        assert_eq!(variation, measure(&[(20, 0, 16), (24, 0, 16)]));
    }

    #[test]
    fn whole_measure_chord_transposes_its_top_note() {
        let primary = measure(&[(30, 0, 16), (34, 0, 16)]);
        let variation = melodic_phrase_end(61, &primary, 16);
        assert_eq!(variation, measure(&[(18, 0, 16), (34, 0, 16)]));
    }

    #[test]
    fn top_note_moves_down_when_no_octave_is_left_above() {
        let primary = measure(&[(5, 0, 12), (9, 0, 12)]);
        let variation = melodic_phrase_end(61, &primary, 12);
        assert_eq!(variation, measure(&[(17, 0, 12), (9, 0, 12)]));
    }

    #[test]
    fn narrow_ranges_still_differ_from_the_primary() {
        for row_count in [8, 20] {
            let chord = measure(&[(2, 0, 16), (5, 0, 16)]);
            assert_ne!(melodic_phrase_end(row_count, &chord, 16), chord);

            let single = measure(&[(3, 0, 16)]);
            let variation = melodic_phrase_end(row_count, &single, 16);
            assert_ne!(variation, single);
            assert!(variation.keys().all(|(row, _)| *row < row_count));

            let one_step = measure(&[(3, 0, 1)]);
            let variation = melodic_phrase_end(row_count, &one_step, 16);
            assert_ne!(variation, one_step);
            assert!(variation.keys().all(|(row, _)| *row < row_count));
        }
    }

    #[test]
    fn colliding_octave_move_still_differs() {
        let primary = measure(&[(2, 0, 16), (14, 0, 16)]);
        let variation = melodic_phrase_end(61, &primary, 16);
        assert_ne!(variation, primary);
        assert_eq!(variation, measure(&[(14, 0, 16)]));
    }

    #[test]
    fn empty_measure_stays_empty() {
        assert!(melodic_phrase_end(61, &MeasureNotes::new(), 16).is_empty());
    }
}
