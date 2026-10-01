use crate::draft::{MeasureNotes, NormalizedDraft, FALLBACK_TEMPO_BPM};
use crate::instruments::{Instrument, Monophony};
use crate::meter::MeasureCount;
use crate::pattern::{Note, Pattern};
use crate::request::GenerateRequest;

/// Four-bar phrases are the most common unit in popular music, so variations
/// placed at their ends sound intentional.
pub const PHRASE_MEASURES: u32 = 4;

/// Request tempo and swing win over the draft's because the user asked for
/// them explicitly.
pub fn build_pattern(draft: &NormalizedDraft, request: &GenerateRequest) -> Pattern {
    let measures = MeasureCount::new(request.measures)
        .expect("pattern requests are validated to an allowed length");
    let mut pattern = Pattern::empty(
        request.instrument,
        draft.name.clone(),
        request
            .tempo_bpm
            .or(draft.tempo_bpm)
            .unwrap_or(FALLBACK_TEMPO_BPM),
        request.time_signature,
        measures,
        request.swing.or(draft.swing).unwrap_or(0.0),
    );
    pattern.notes = build_notes(
        draft,
        GenerationSpan {
            measures: request.measures,
            steps_per_measure: request.time_signature.steps_per_measure(),
        },
        request.instrument,
    );
    pattern
}

pub const MAX_SPAN_MEASURES: u32 = 32;

/// Separate from `MeasureCount` because song ranges can be any length up to
/// 32 measures, while the pattern API's five accepted lengths are a published
/// contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenerationSpan {
    measures: u32,
    steps_per_measure: u32,
}

impl GenerationSpan {
    pub fn new(measures: u32, steps_per_measure: u32) -> Option<Self> {
        ((1..=MAX_SPAN_MEASURES).contains(&measures) && steps_per_measure > 0).then_some(Self {
            measures,
            steps_per_measure,
        })
    }

    pub fn measures(self) -> u32 {
        self.measures
    }

    pub fn steps_per_measure(self) -> u32 {
        self.steps_per_measure
    }

    pub fn total_steps(self) -> u32 {
        self.measures * self.steps_per_measure
    }
}

/// Notes are counted from the span's first step so callers can store them
/// without an offset, whether the span is a whole pattern or a song range.
pub fn build_notes(
    draft: &NormalizedDraft,
    span: GenerationSpan,
    instrument: &Instrument,
) -> Vec<Note> {
    let steps_per_measure = span.steps_per_measure;
    let n = span.measures as usize;
    let mut sections: Vec<MeasureNotes> = draft.sections.clone();
    let mut layout: Vec<usize> = (0..n)
        .map(|i| draft.arrangement[i % draft.arrangement.len()])
        .collect();

    if n > PHRASE_MEASURES as usize {
        let primary = sections[layout[0]].clone();
        let variation = choose_variation(&draft.arrangement, &sections, &primary).or_else(|| {
            let hook = instrument.fallback_variation?;
            sections.push(hook(&primary, steps_per_measure));
            Some(sections.len() - 1)
        });
        if let Some(variation) = variation {
            let phrase = PHRASE_MEASURES as usize;
            for i in (phrase - 1..n).step_by(phrase) {
                if sections[layout[i]] == primary {
                    layout[i] = variation;
                }
            }
        }
    }

    let raw: Vec<RawNote> = layout
        .iter()
        .enumerate()
        .flat_map(|(measure, &section)| {
            let offset = measure as u32 * steps_per_measure;
            sections[section]
                .iter()
                .map(move |(&(row, step), note)| RawNote {
                    row,
                    step: offset + step,
                    length: note.length,
                    velocity: note.velocity,
                })
        })
        .collect();

    let raw = enforce_monophony(raw, instrument);

    settle(raw, span.total_steps())
        .into_iter()
        .map(|n| Note {
            row_id: instrument.rows[n.row].id.to_string(),
            step: n.step,
            length_steps: n.length,
            velocity: n.velocity,
        })
        .collect()
}

/// Runs on the expanded line rather than per section so a note held across a
/// barline is also clipped by the next measure's first onset.
fn enforce_monophony(mut notes: Vec<RawNote>, instrument: &Instrument) -> Vec<RawNote> {
    let pitch = |n: &RawNote| instrument.rows[n.row].midi_note;
    match instrument.monophony {
        Monophony::None => return notes,
        Monophony::KeepLowest => notes.sort_by_key(|n| (n.step, pitch(n))),
        Monophony::KeepHighest => {
            notes.sort_by_key(|n| (n.step, std::cmp::Reverse(pitch(n))));
        }
    }
    notes.dedup_by_key(|n| n.step);

    for i in 1..notes.len() {
        let next_onset = notes[i].step;
        let previous = &mut notes[i - 1];
        previous.length = previous.length.min(next_onset - previous.step);
    }
    notes
}

/// Prefer a section the model placed in its arrangement: that is the variation
/// it intended. Empty sections are skipped because lanes with unknown rows are
/// dropped, and an empty phrase-end measure would read as a silent glitch
/// rather than a fill.
fn choose_variation(
    arrangement: &[usize],
    sections: &[MeasureNotes],
    primary: &MeasureNotes,
) -> Option<usize> {
    arrangement
        .iter()
        .rev()
        .copied()
        .find(|&i| is_variation(&sections[i], primary))
        .or_else(|| {
            (0..sections.len())
                .rev()
                .find(|&i| is_variation(&sections[i], primary))
        })
}

fn is_variation(section: &MeasureNotes, primary: &MeasureNotes) -> bool {
    !section.is_empty() && section != primary
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RawNote {
    pub row: usize,
    pub step: u32,
    pub length: u32,
    pub velocity: u8,
}

/// Sections are one measure long so they cannot overlap or overrun today, but
/// the pattern invariants must hold however notes were produced, so they are
/// enforced here in one place. An earlier note is shortened to end where the
/// next one on its row begins.
pub(crate) fn settle(mut notes: Vec<RawNote>, total_steps: u32) -> Vec<RawNote> {
    notes.retain(|n| n.step < total_steps);
    // Loudest first at a shared step so dedupe keeps the accent.
    notes.sort_by_key(|n| (n.row, n.step, std::cmp::Reverse(n.velocity)));
    notes.dedup_by_key(|n| (n.row, n.step));

    for i in 0..notes.len() {
        let mut end = total_steps;
        if let Some(next) = notes.get(i + 1).filter(|next| next.row == notes[i].row) {
            end = end.min(next.step);
        }
        notes[i].length = notes[i].length.max(1).min(end - notes[i].step);
    }
    notes.sort_by_key(|n| (n.step, n.row));
    notes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft::PatternDraft;
    use crate::instruments::bass::BASS;
    use crate::instruments::drums::DRUMS;
    use crate::instruments::piano::PIANO;
    use crate::instruments::synth_lead::SYNTH_LEAD;
    use crate::instruments::InstrumentRegistry;
    use crate::request::GenerateRequestBody;
    use serde_json::json;

    fn request(measures: i64, time_signature: &str) -> GenerateRequest {
        GenerateRequestBody {
            instrument: "drums".into(),
            prompt: "groove".into(),
            measures,
            time_signature: Some(time_signature.into()),
            ..Default::default()
        }
        .validate(&InstrumentRegistry::builtin(), 256)
        .unwrap()
    }

    fn normalize(draft: PatternDraft, spm: u32) -> NormalizedDraft {
        draft.normalize(&DRUMS, spm).unwrap()
    }

    fn one_section_draft() -> PatternDraft {
        PatternDraft::from_json(json!({
            "name": "Rock",
            "tempo_bpm": 100,
            "swing": 0.1,
            "sections": [{"id": "A", "lanes": [
                {"lane": "kick", "steps": "x.......x......."},
                {"lane": "snare", "steps": "....x.......x..."},
                {"lane": "hat_closed", "steps": "x.x.x.x.x.x.x.x."},
            ]}],
            "arrangement": ["A"]
        }))
        .unwrap()
    }

    fn measure_notes(p: &Pattern, m: u32) -> Vec<(String, u32, u32, u8)> {
        let spm = p.steps_per_measure;
        p.notes
            .iter()
            .filter(|n| n.step / spm == m)
            .map(|n| (n.row_id.clone(), n.step % spm, n.length_steps, n.velocity))
            .collect()
    }

    #[test]
    fn every_allowed_length_expands_in_range() {
        for ts in ["4/4", "3/4", "6/8"] {
            for m in [4, 8, 12, 16, 32] {
                let req = request(m, ts);
                let draft = normalize(one_section_draft(), req.time_signature.steps_per_measure());
                let p = build_pattern(&draft, &req);
                assert_eq!(p.measures.get(), m as u32);
                assert!(
                    p.notes
                        .iter()
                        .all(|n| n.step + n.length_steps <= p.total_steps()),
                    "{ts} {m}"
                );
                assert!(!measure_notes(&p, m as u32 - 1).is_empty(), "{ts} {m}");
            }
        }
    }

    #[test]
    fn pattern_carries_instrument_rows_and_channel() {
        let p = build_pattern(&normalize(one_section_draft(), 16), &request(4, "4/4"));
        assert_eq!(p.instrument, "drums");
        assert_eq!(p.midi_channel, 10);
        assert_eq!(p.rows, DRUMS.row_list());
    }

    #[test]
    fn request_tempo_and_swing_override_draft() {
        let mut req = request(4, "4/4");
        let draft = normalize(one_section_draft(), 16);
        let p = build_pattern(&draft, &req);
        assert_eq!((p.tempo_bpm, p.swing), (100, 0.1));
        req.tempo_bpm = Some(140);
        req.swing = Some(0.0);
        let p = build_pattern(&draft, &req);
        assert_eq!((p.tempo_bpm, p.swing), (140, 0.0));
    }

    #[test]
    fn four_measures_repeat_without_forced_fill() {
        let p = build_pattern(&normalize(one_section_draft(), 16), &request(4, "4/4"));
        for m in 1..4 {
            assert_eq!(measure_notes(&p, m), measure_notes(&p, 0));
        }
    }

    #[test]
    fn sixteen_measures_get_fallback_fills_at_phrase_ends() {
        let p = build_pattern(&normalize(one_section_draft(), 16), &request(16, "4/4"));
        let first = measure_notes(&p, 0);
        for m in 0..16 {
            let is_phrase_end = m % 4 == 3;
            assert_eq!(measure_notes(&p, m) != first, is_phrase_end, "measure {m}");
        }
    }

    fn span_measure_notes(measures: u32, m: u32) -> Vec<(String, u32)> {
        let span = GenerationSpan::new(measures, 16).unwrap();
        let notes = build_notes(&normalize(one_section_draft(), 16), span, &DRUMS);
        assert!(notes
            .iter()
            .all(|n| n.step + n.length_steps <= span.total_steps()));
        notes
            .iter()
            .filter(|n| n.step / 16 == m)
            .map(|n| (n.row_id.clone(), n.step % 16))
            .collect()
    }

    #[test]
    fn a_one_measure_span_has_no_fallback_and_stays_in_bounds() {
        assert!(!span_measure_notes(1, 0).is_empty());
        assert!(span_measure_notes(1, 1).is_empty());
    }

    #[test]
    fn a_five_measure_span_varies_only_its_fourth_measure() {
        let first = span_measure_notes(5, 0);
        for m in 0..5 {
            assert_eq!(span_measure_notes(5, m) != first, m == 3, "measure {m}");
        }
    }

    #[test]
    fn a_seven_measure_span_varies_only_its_fourth_measure() {
        let first = span_measure_notes(7, 0);
        for m in 0..7 {
            assert_eq!(span_measure_notes(7, m) != first, m == 3, "measure {m}");
        }
    }

    #[test]
    fn spans_longer_than_a_song_range_are_refused() {
        assert!(GenerationSpan::new(0, 16).is_none());
        assert!(GenerationSpan::new(33, 16).is_none());
        assert!(GenerationSpan::new(32, 16).is_some());
    }

    #[test]
    fn model_variation_is_used_at_phrase_ends() {
        let draft = normalize(
            PatternDraft::from_json(json!({
                "name": "AB",
                "sections": [
                    {"id": "A", "lanes": [{"lane": "kick", "steps": "x...x...x...x..."}]},
                    {"id": "fill", "lanes": [{"lane": "tom_low", "steps": "....xxxxxxxxXXXX"}]}
                ],
                "arrangement": ["A", "A"]
            }))
            .unwrap(),
            16,
        );
        let p = build_pattern(&draft, &request(8, "4/4"));
        for m in [3, 7] {
            assert!(measure_notes(&p, m).iter().all(|n| n.0 == "tom_low"));
        }
        assert!(measure_notes(&p, 2).iter().all(|n| n.0 == "kick"));
    }

    #[test]
    fn empty_section_is_not_used_as_the_variation() {
        let draft = normalize(
            PatternDraft::from_json(json!({
                "name": "Ghost",
                "sections": [
                    {"id": "A", "lanes": [{"lane": "kick", "steps": "x...x...x...x..."}]},
                    {"id": "gone", "lanes": [{"lane": "not_a_row", "steps": "x..............."}]}
                ],
                "arrangement": ["A", "gone", "A", "A"]
            }))
            .unwrap(),
            16,
        );
        let p = build_pattern(&draft, &request(8, "4/4"));
        for m in [3, 7] {
            assert!(!measure_notes(&p, m).is_empty(), "measure {m}");
            assert_ne!(measure_notes(&p, m), measure_notes(&p, 0), "measure {m}");
        }
    }

    #[test]
    fn held_notes_survive_expansion() {
        let draft = normalize(
            PatternDraft::from_json(json!({
                "name": "Hold",
                "sections": [{"id": "A", "lanes": [{"lane": "crash", "steps": "x---............"}]}],
                "arrangement": ["A"]
            }))
            .unwrap(),
            16,
        );
        let p = build_pattern(&draft, &request(4, "4/4"));
        assert!(measure_notes(&p, 0).contains(&("crash".into(), 0, 4, 90)));
    }

    #[test]
    fn notes_are_sorted_unique_and_valid() {
        let p = build_pattern(&normalize(one_section_draft(), 16), &request(32, "4/4"));
        let mut seen = std::collections::HashSet::new();
        for pair in p.notes.windows(2) {
            assert!(pair[0].step <= pair[1].step);
        }
        for n in &p.notes {
            assert!(seen.insert((n.row_id.clone(), n.step)));
            assert!(p.row(&n.row_id).is_some());
            assert!((1..=127).contains(&n.velocity));
            assert!(n.length_steps >= 1);
        }
    }

    fn raw(row: usize, step: u32, length: u32, velocity: u8) -> RawNote {
        RawNote {
            row,
            step,
            length,
            velocity,
        }
    }

    #[test]
    fn overlapping_notes_on_a_row_are_shortened() {
        let settled = settle(
            vec![raw(0, 0, 8, 90), raw(0, 4, 1, 90), raw(1, 2, 8, 90)],
            64,
        );
        assert_eq!(
            settled,
            vec![raw(0, 0, 4, 90), raw(1, 2, 8, 90), raw(0, 4, 1, 90)]
        );
    }

    #[test]
    fn notes_are_truncated_at_pattern_end_and_out_of_range_dropped() {
        let settled = settle(vec![raw(0, 60, 10, 90), raw(0, 64, 1, 90)], 64);
        assert_eq!(settled, vec![raw(0, 60, 4, 90)]);
    }

    #[test]
    fn same_step_duplicates_keep_the_loudest() {
        let settled = settle(vec![raw(0, 0, 1, 35), raw(0, 0, 1, 120)], 16);
        assert_eq!(settled, vec![raw(0, 0, 1, 120)]);
    }

    fn line_draft(
        instrument: &'static Instrument,
        sections: serde_json::Value,
        arrangement: &[&str],
    ) -> NormalizedDraft {
        PatternDraft::from_json(json!({
            "name": "Line",
            "sections": sections,
            "arrangement": arrangement
        }))
        .unwrap()
        .normalize(instrument, 16)
        .unwrap()
    }

    fn line_request(instrument: &str, measures: i64) -> GenerateRequest {
        GenerateRequestBody {
            instrument: instrument.into(),
            prompt: "line".into(),
            measures,
            ..Default::default()
        }
        .validate(&InstrumentRegistry::builtin(), 256)
        .unwrap()
    }

    fn line(p: &Pattern) -> Vec<(String, u32, u32)> {
        p.notes
            .iter()
            .map(|n| (n.row_id.clone(), n.step, n.length_steps))
            .collect()
    }

    #[test]
    fn bass_keeps_the_lowest_note_at_a_step() {
        let draft = line_draft(
            &BASS,
            json!([{"id": "A", "lanes": [
                {"lane": "C2", "steps": "x..............."},
                {"lane": "G2", "steps": "x..............."},
            ]}]),
            &["A"],
        );
        let p = build_pattern(&draft, &line_request("bass", 4));
        assert!(line(&p).contains(&("C2".into(), 0, 1)));
        assert!(p.notes.iter().all(|n| n.row_id != "G2"));
    }

    #[test]
    fn synth_lead_keeps_the_highest_note_at_a_step() {
        let draft = line_draft(
            &SYNTH_LEAD,
            json!([{"id": "A", "lanes": [
                {"lane": "E4", "steps": "........x......."},
                {"lane": "C5", "steps": "........x......."},
            ]}]),
            &["A"],
        );
        let p = build_pattern(&draft, &line_request("synth-lead", 4));
        assert!(line(&p).contains(&("C5".into(), 8, 1)));
        assert!(p.notes.iter().all(|n| n.row_id != "E4"));
    }

    #[test]
    fn a_held_bass_note_is_clipped_by_the_next_onset() {
        let draft = line_draft(
            &BASS,
            json!([{"id": "A", "lanes": [
                {"lane": "C2", "steps": "x-------........"},
                {"lane": "F2", "steps": "....x..........."},
            ]}]),
            &["A"],
        );
        let p = build_pattern(&draft, &line_request("bass", 4));
        assert!(line(&p).contains(&("C2".into(), 0, 4)));
    }

    #[test]
    fn a_note_is_clipped_by_the_next_onset_across_a_measure_boundary() {
        // Sections cap holds at the barline today, so the overlap is built directly.
        let clipped = enforce_monophony(vec![raw(19, 12, 8, 90), raw(14, 16, 4, 90)], &BASS);
        assert_eq!(clipped, vec![raw(19, 12, 4, 90), raw(14, 16, 4, 90)]);
    }

    #[test]
    fn piano_chords_are_unaffected_by_monophony() {
        let draft = piano_draft(json!([
            {"lane": "C4", "steps": "x---------------"},
            {"lane": "E4", "steps": "x---------------"},
        ]));
        let p = build_pattern(&draft, &piano_request(4));
        assert_eq!(measure_notes(&p, 0).len(), 2);
    }

    fn piano_request(measures: i64) -> GenerateRequest {
        GenerateRequestBody {
            instrument: "piano".into(),
            prompt: "chords".into(),
            measures,
            ..Default::default()
        }
        .validate(&InstrumentRegistry::builtin(), 256)
        .unwrap()
    }

    fn piano_draft(lanes: serde_json::Value) -> NormalizedDraft {
        PatternDraft::from_json(json!({
            "name": "Keys",
            "sections": [{"id": "A", "lanes": lanes}],
            "arrangement": ["A"]
        }))
        .unwrap()
        .normalize(&PIANO, 16)
        .unwrap()
    }

    #[test]
    fn repeated_piano_part_varies_at_phrase_ends() {
        let draft = piano_draft(json!([
            {"lane": "C4", "steps": "x...x...x...x..."},
            {"lane": "E4", "steps": "x...x...x...x..."},
            {"lane": "C3", "steps": "x-------x-------"},
        ]));
        let p = build_pattern(&draft, &piano_request(8));
        let first = measure_notes(&p, 0);
        for m in 0..8 {
            assert_eq!(measure_notes(&p, m) != first, m % 4 == 3, "measure {m}");
        }
        assert!(p.notes.iter().all(|n| p.row(&n.row_id).is_some()));
        assert!(p.notes.iter().all(|n| PIANO.row_index(&n.row_id).is_some()));
    }

    #[test]
    fn whole_note_chord_varies_at_every_phrase_end() {
        let draft = piano_draft(json!([
            {"lane": "C4", "steps": "x---------------"},
            {"lane": "E4", "steps": "x---------------"},
            {"lane": "G4", "steps": "x---------------"},
        ]));
        let p = build_pattern(&draft, &piano_request(16));
        let first = measure_notes(&p, 0);
        for m in 0..16 {
            assert_eq!(measure_notes(&p, m) != first, m % 4 == 3, "measure {m}");
        }
        assert!(p.notes.iter().all(|n| PIANO.row_index(&n.row_id).is_some()));
        assert_eq!(p.midi_program, Some(1));
    }
}
