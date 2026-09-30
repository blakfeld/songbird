use midly::num::{u15, u24, u28, u4, u7};
use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};

use crate::expand::{settle, RawNote};
use crate::meter::{TimeSignature, MAX_SWING, MAX_TEMPO_BPM, MIN_SWING, MIN_TEMPO_BPM};
use crate::pattern::Pattern;
use crate::timing::{step_to_ticks, PPQ};

#[derive(Debug, thiserror::Error)]
pub enum MidiError {
    /// The message names the offending field so a caller can show it verbatim.
    #[error("{0}")]
    InvalidPattern(String),
    #[error("failed to serialize MIDI: {0}")]
    Write(#[from] std::io::Error),
}

fn invalid(message: impl Into<String>) -> MidiError {
    MidiError::InvalidPattern(message.into())
}

/// Export accepts client-edited documents, so every numeric field is checked
/// here rather than trusted: out-of-range values would otherwise overflow tick
/// math or produce a file no DAW can read.
pub fn validate_for_export(pattern: &Pattern) -> Result<(), MidiError> {
    if !(MIN_TEMPO_BPM..=MAX_TEMPO_BPM).contains(&pattern.tempo_bpm) {
        return Err(invalid(format!(
            "tempo_bpm must be {MIN_TEMPO_BPM}-{MAX_TEMPO_BPM}, got {}",
            pattern.tempo_bpm
        )));
    }
    if !(MIN_SWING..=MAX_SWING).contains(&pattern.swing) {
        return Err(invalid(format!(
            "swing must be {MIN_SWING}-{MAX_SWING}, got {}",
            pattern.swing
        )));
    }
    let expected_steps = pattern.time_signature.steps_per_measure();
    if pattern.steps_per_measure != expected_steps {
        return Err(invalid(format!(
            "steps_per_measure must be {expected_steps} for {}, got {}",
            pattern.time_signature.as_str(),
            pattern.steps_per_measure
        )));
    }
    if !(1..=16).contains(&pattern.midi_channel) {
        return Err(invalid(format!(
            "midi_channel must be 1-16, got {}",
            pattern.midi_channel
        )));
    }
    if let Some(program) = pattern.midi_program {
        if !(1..=128).contains(&program) {
            return Err(invalid(format!(
                "midi_program must be 1-128, got {program}"
            )));
        }
    }
    if let Some(row) = pattern.rows.iter().find(|r| r.midi_note > 127) {
        return Err(invalid(format!(
            "row `{}` has midi_note {} above 127",
            row.id, row.midi_note
        )));
    }
    let total_steps = pattern.total_steps();
    for (i, note) in pattern.notes.iter().enumerate() {
        if pattern.row(&note.row_id).is_none() {
            return Err(invalid(format!(
                "notes[{i}] references unknown row `{}`",
                note.row_id
            )));
        }
        if note.step >= total_steps {
            return Err(invalid(format!(
                "notes[{i}].step {} is outside the pattern ({total_steps} steps)",
                note.step
            )));
        }
        if note.length_steps == 0 {
            return Err(invalid(format!(
                "notes[{i}].length_steps must be at least 1"
            )));
        }
        if !(1..=127).contains(&note.velocity) {
            return Err(invalid(format!(
                "notes[{i}].velocity must be 1-127, got {}",
                note.velocity
            )));
        }
    }
    Ok(())
}

/// Note Offs sort before Note Ons at the same tick so a retriggered pitch is
/// released first and never has its new note cut short by the stale Off.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    Off,
    On,
}

pub fn pattern_to_midi(pattern: &Pattern) -> Result<Vec<u8>, MidiError> {
    validate_for_export(pattern)?;
    let channel = u4::new(pattern.midi_channel - 1);
    let total_steps = pattern.total_steps();
    let end_tick = step_to_ticks(total_steps, pattern.swing);

    let raw: Vec<RawNote> = pattern
        .notes
        .iter()
        .filter_map(|note| {
            let row = pattern.rows.iter().position(|r| r.id == note.row_id)?;
            Some(RawNote {
                row,
                step: note.step,
                length: note.length_steps,
                velocity: note.velocity,
            })
        })
        .collect();
    // Overlapping notes on one row would emit On, On, Off, Off, which players
    // pair up ambiguously, so they are shortened exactly as generation does.
    let settled = settle(raw, total_steps);

    let mut timed: Vec<(u32, Phase, u8, u8)> = Vec::with_capacity(settled.len() * 2);
    for note in settled {
        let key = pattern.rows[note.row].midi_note;
        let start = step_to_ticks(note.step, pattern.swing);
        let end = step_to_ticks(note.step + note.length, pattern.swing).min(end_tick);
        if end <= start {
            continue;
        }
        timed.push((start, Phase::On, key, note.velocity));
        timed.push((end, Phase::Off, key, 0));
    }
    timed.sort_by_key(|&(tick, phase, key, _)| (tick, phase, key));

    let mut note_track = vec![meta(
        0,
        MetaMessage::TrackName(pattern.instrument.as_bytes()),
    )];
    if let Some(program) = pattern.midi_program {
        note_track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Midi {
                channel,
                // The pattern stores GM programs 1-based like channels.
                message: MidiMessage::ProgramChange {
                    program: u7::new(program - 1),
                },
            },
        });
    }
    let mut previous = 0;
    for (tick, phase, key, velocity) in timed {
        let message = match phase {
            Phase::On => MidiMessage::NoteOn {
                key: u7::new(key),
                vel: u7::new(velocity),
            },
            Phase::Off => MidiMessage::NoteOff {
                key: u7::new(key),
                vel: u7::new(0),
            },
        };
        note_track.push(TrackEvent {
            delta: u28::new(tick - previous),
            kind: TrackEventKind::Midi { channel, message },
        });
        previous = tick;
    }
    note_track.push(meta(end_tick - previous, MetaMessage::EndOfTrack));

    let micros_per_quarter = (60_000_000.0 / f64::from(pattern.tempo_bpm)).round() as u32;
    let tempo_track = vec![
        meta(0, MetaMessage::TrackName(pattern.name.as_bytes())),
        meta(0, MetaMessage::Tempo(u24::new(micros_per_quarter))),
        meta(
            0,
            MetaMessage::TimeSignature(
                pattern.time_signature.numerator(),
                pattern.time_signature.denominator().trailing_zeros() as u8,
                clocks_per_click(pattern.time_signature),
                8,
            ),
        ),
        meta(end_tick, MetaMessage::EndOfTrack),
    ];

    let smf = Smf {
        header: Header::new(Format::Parallel, Timing::Metrical(u15::new(PPQ as u16))),
        tracks: vec![tempo_track, note_track],
    };
    let mut bytes = Vec::new();
    smf.write_std(&mut bytes)?;
    Ok(bytes)
}

/// 6/8 is felt in dotted-quarter beats, so the metronome click spans three eighths.
fn clocks_per_click(time_signature: TimeSignature) -> u8 {
    match time_signature {
        TimeSignature::FourFour | TimeSignature::ThreeFour => 24,
        TimeSignature::SixEight => 36,
    }
}

fn meta(delta: u32, message: MetaMessage<'_>) -> TrackEvent<'_> {
    TrackEvent {
        delta: u28::new(delta),
        kind: TrackEventKind::Meta(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::drums::DRUMS;
    use crate::instruments::piano::PIANO;
    use crate::meter::MeasureCount;
    use crate::pattern::Note;
    use midly::{MetaMessage as M, MidiMessage as Mm};

    fn pattern(ts: TimeSignature, bpm: u32, measures: u32, swing: f64) -> Pattern {
        Pattern::empty(
            &DRUMS,
            "Test Groove",
            bpm,
            ts,
            MeasureCount::new(measures).unwrap(),
            swing,
        )
    }

    fn note(row: &str, step: u32, length: u32, velocity: u8) -> Note {
        Note {
            row_id: row.into(),
            step,
            length_steps: length,
            velocity,
        }
    }

    fn channel_events(bytes: &[u8]) -> Vec<(u32, u8, Mm)> {
        let smf = Smf::parse(bytes).unwrap();
        let mut tick = 0;
        let mut out = Vec::new();
        for event in &smf.tracks[1] {
            tick += event.delta.as_int();
            if let TrackEventKind::Midi { channel, message } = event.kind {
                out.push((tick, channel.as_int(), message));
            }
        }
        out
    }

    fn end_of_track_tick(track: &[TrackEvent<'_>]) -> u32 {
        let total: u32 = track.iter().map(|e| e.delta.as_int()).sum();
        assert!(matches!(
            track.last().unwrap().kind,
            TrackEventKind::Meta(M::EndOfTrack)
        ));
        total
    }

    #[test]
    fn kick_and_snare_land_on_channel_ten_with_one_step_release() {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.0);
        p.notes = vec![note("kick", 0, 1, 110), note("snare", 4, 1, 90)];
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        let on = |key: u8, vel: u8| Mm::NoteOn {
            key: key.into(),
            vel: vel.into(),
        };
        let off = |key: u8| Mm::NoteOff {
            key: key.into(),
            vel: 0.into(),
        };
        assert_eq!(
            events,
            vec![
                (0, 9, on(36, 110)),
                (120, 9, off(36)),
                (480, 9, on(38, 90)),
                (600, 9, off(38)),
            ]
        );
    }

    #[test]
    fn length_eight_note_off_at_960() {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.0);
        p.notes = vec![note("kick", 0, 8, 100)];
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        assert_eq!(events[1].0, 960);
        assert!(matches!(events[1].2, Mm::NoteOff { .. }));
    }

    #[test]
    fn swing_shifts_odd_step_start_and_end() {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.5);
        p.notes = vec![note("kick", 1, 1, 100), note("snare", 2, 1, 100)];
        let ticks: Vec<u32> = channel_events(&pattern_to_midi(&p).unwrap())
            .iter()
            .map(|e| e.0)
            .collect();
        assert_eq!(ticks, vec![180, 240, 240, 420]);
    }

    #[test]
    fn retrigger_at_same_tick_releases_before_striking() {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.0);
        p.notes = vec![note("kick", 0, 1, 100), note("kick", 1, 1, 100)];
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        assert!(matches!(events[1].2, Mm::NoteOff { .. }));
        assert!(matches!(events[2].2, Mm::NoteOn { .. }));
        assert_eq!(events[1].0, events[2].0);
    }

    #[test]
    fn end_of_track_is_pattern_end_on_both_tracks() {
        let mut p = pattern(TimeSignature::FourFour, 120, 8, 0.0);
        p.notes = vec![note("kick", 5 * 16, 1, 100)];
        let bytes = pattern_to_midi(&p).unwrap();
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(end_of_track_tick(&smf.tracks[0]), 15360);
        assert_eq!(end_of_track_tick(&smf.tracks[1]), 15360);
    }

    #[test]
    fn header_is_type_one_at_480_ppq() {
        let bytes = pattern_to_midi(&pattern(TimeSignature::FourFour, 120, 4, 0.0)).unwrap();
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(smf.header.format, Format::Parallel);
        assert_eq!(smf.header.timing, Timing::Metrical(u15::new(480)));
        assert_eq!(smf.tracks.len(), 2);
    }

    #[test]
    fn three_four_at_96_bpm_meta_events() {
        let bytes = pattern_to_midi(&pattern(TimeSignature::ThreeFour, 96, 4, 0.0)).unwrap();
        let smf = Smf::parse(&bytes).unwrap();
        let metas: Vec<_> = smf.tracks[0]
            .iter()
            .filter_map(|e| match e.kind {
                TrackEventKind::Meta(m) => Some(m),
                _ => None,
            })
            .collect();
        assert!(metas.contains(&M::Tempo(u24::new(625_000))));
        assert!(metas.contains(&M::TimeSignature(3, 2, 24, 8)));
        assert!(metas.contains(&M::TrackName(b"Test Groove")));
        assert_eq!(end_of_track_tick(&smf.tracks[0]), 4 * 3 * 480);
    }

    #[test]
    fn six_eight_time_signature_uses_eighth_denominator() {
        let bytes = pattern_to_midi(&pattern(TimeSignature::SixEight, 120, 4, 0.0)).unwrap();
        let smf = Smf::parse(&bytes).unwrap();
        assert!(smf.tracks[0]
            .iter()
            .any(|e| e.kind == TrackEventKind::Meta(M::TimeSignature(6, 3, 36, 8))));
    }

    #[test]
    fn round_trip_recovers_notes_velocities_and_durations() {
        let mut p = pattern(TimeSignature::FourFour, 100, 4, 0.2);
        p.notes = vec![
            note("kick", 0, 2, 111),
            note("snare", 4, 1, 64),
            note("hat_closed", 7, 3, 20),
        ];
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        let mut recovered = Vec::new();
        for (start, _, message) in &events {
            if let Mm::NoteOn { key, vel } = message {
                let end = events
                    .iter()
                    .find(|(t, _, m)| {
                        t > start && matches!(m, Mm::NoteOff { key: k, .. } if k == key)
                    })
                    .unwrap()
                    .0;
                recovered.push((key.as_int(), vel.as_int(), *start, end - start));
            }
        }
        assert_eq!(
            recovered,
            vec![(36, 111, 0, 240), (38, 64, 480, 144), (42, 20, 864, 336)]
        );
    }

    fn export_error(edit: impl FnOnce(&mut Pattern)) -> String {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.0);
        p.notes = vec![note("kick", 0, 1, 100)];
        edit(&mut p);
        match pattern_to_midi(&p) {
            Err(MidiError::InvalidPattern(message)) => message,
            other => panic!("expected InvalidPattern, got {other:?}"),
        }
    }

    #[test]
    fn out_of_range_fields_are_rejected_naming_the_field() {
        assert!(export_error(|p| p.notes[0].row_id = "cowbell".into()).contains("cowbell"));
        assert!(export_error(|p| p.midi_channel = 0).contains("midi_channel"));
        assert!(export_error(|p| p.midi_channel = 17).contains("midi_channel"));
        assert!(export_error(|p| p.tempo_bpm = 0).contains("tempo_bpm"));
        assert!(export_error(|p| p.tempo_bpm = 1).contains("tempo_bpm"));
        assert!(export_error(|p| p.tempo_bpm = 241).contains("tempo_bpm"));
        assert!(export_error(|p| p.swing = 1e12).contains("swing"));
        assert!(export_error(|p| p.swing = f64::NAN).contains("swing"));
        assert!(export_error(|p| p.steps_per_measure = 4_000_000_000).contains("steps_per_measure"));
        assert!(export_error(|p| p.steps_per_measure = 12).contains("steps_per_measure"));
        assert!(export_error(|p| p.notes[0].step = u32::MAX).contains("step"));
        assert!(export_error(|p| p.notes[0].step = 64).contains("step"));
        assert!(export_error(|p| p.notes[0].length_steps = 0).contains("length_steps"));
        assert!(export_error(|p| p.notes[0].velocity = 0).contains("velocity"));
        assert!(export_error(|p| p.notes[0].velocity = 128).contains("velocity"));
        assert!(export_error(|p| p.rows[0].midi_note = 200).contains("midi_note"));
        assert!(export_error(|p| p.midi_program = Some(0)).contains("midi_program"));
        assert!(export_error(|p| p.midi_program = Some(129)).contains("midi_program"));
    }

    #[test]
    fn huge_length_is_clamped_to_pattern_end_without_overflow() {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.0);
        p.notes = vec![note("kick", 60, u32::MAX, 100)];
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        assert_eq!(events[0].0, 60 * 120);
        assert_eq!(events[1].0, 64 * 120);
    }

    #[test]
    fn overlapping_notes_on_a_row_are_shortened_before_writing() {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.0);
        p.notes = vec![note("kick", 0, 8, 100), note("kick", 4, 1, 100)];
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        let kinds: Vec<(u32, bool)> = events
            .iter()
            .map(|(t, _, m)| (*t, matches!(m, Mm::NoteOn { .. })))
            .collect();
        assert_eq!(
            kinds,
            vec![(0, true), (480, false), (480, true), (600, false)]
        );
    }

    #[test]
    fn every_note_off_follows_its_note_on() {
        let mut p = pattern(TimeSignature::SixEight, 120, 4, 0.75);
        p.notes = (0..48).map(|s| note("kick", s, 1, 100)).collect();
        let mut sounding = 0i32;
        for (_, _, message) in channel_events(&pattern_to_midi(&p).unwrap()) {
            match message {
                Mm::NoteOn { .. } => sounding += 1,
                Mm::NoteOff { .. } => sounding -= 1,
                _ => {}
            }
            assert!((0..=1).contains(&sounding));
        }
        assert_eq!(sounding, 0);
    }

    fn piano_pattern(notes: &[(&str, u32, u32, u8)]) -> Pattern {
        let mut p = Pattern::empty(
            &PIANO,
            "Chords",
            100,
            TimeSignature::FourFour,
            MeasureCount::new(4).unwrap(),
            0.0,
        );
        p.notes = notes
            .iter()
            .map(|&(row, step, length, velocity)| note(row, step, length, velocity))
            .collect();
        p
    }

    fn on(key: u8, vel: u8) -> Mm {
        Mm::NoteOn {
            key: key.into(),
            vel: vel.into(),
        }
    }

    fn off(key: u8) -> Mm {
        Mm::NoteOff {
            key: key.into(),
            vel: 0.into(),
        }
    }

    #[test]
    fn program_change_precedes_notes_with_zero_based_wire_value() {
        let p = piano_pattern(&[("C4", 0, 4, 90)]);
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        assert_eq!(
            events,
            vec![
                (0, 0, Mm::ProgramChange { program: 0.into() }),
                (0, 0, on(60, 90)),
                (480, 0, off(60)),
            ]
        );
    }

    #[test]
    fn program_change_follows_the_track_name() {
        let bytes = pattern_to_midi(&piano_pattern(&[("C4", 0, 4, 90)])).unwrap();
        let smf = Smf::parse(&bytes).unwrap();
        assert!(matches!(
            smf.tracks[1][0].kind,
            TrackEventKind::Meta(M::TrackName(_))
        ));
        assert!(matches!(
            smf.tracks[1][1].kind,
            TrackEventKind::Midi {
                message: Mm::ProgramChange { .. },
                ..
            }
        ));
    }

    #[test]
    fn drums_export_has_no_program_change() {
        let mut p = pattern(TimeSignature::FourFour, 120, 4, 0.0);
        p.notes = vec![note("kick", 0, 1, 100)];
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        assert!(events
            .iter()
            .all(|(_, _, m)| !matches!(m, Mm::ProgramChange { .. })));
    }

    #[test]
    fn program_128_is_wire_value_127() {
        let mut p = piano_pattern(&[("C4", 0, 4, 90)]);
        p.midi_program = Some(128);
        let events = channel_events(&pattern_to_midi(&p).unwrap());
        assert_eq!(
            events[0].2,
            Mm::ProgramChange {
                program: 127.into()
            }
        );
    }

    #[test]
    fn chord_starts_together_and_releases_at_the_barline() {
        let p = piano_pattern(&[("C4", 0, 16, 80), ("E4", 0, 16, 80), ("G4", 0, 16, 80)]);
        let events: Vec<_> = channel_events(&pattern_to_midi(&p).unwrap())
            .into_iter()
            .filter(|(_, _, m)| !matches!(m, Mm::ProgramChange { .. }))
            .collect();
        assert_eq!(
            events,
            vec![
                (0, 0, on(60, 80)),
                (0, 0, on(64, 80)),
                (0, 0, on(67, 80)),
                (1920, 0, off(60)),
                (1920, 0, off(64)),
                (1920, 0, off(67)),
            ]
        );
    }

    #[test]
    fn piano_round_trip_recovers_pitches_and_program() {
        let mut p = piano_pattern(&[("C7", 0, 2, 100), ("C2", 4, 4, 70), ("C#4", 8, 1, 50)]);
        p.midi_program = Some(5);
        let bytes = pattern_to_midi(&p).unwrap();
        let smf = Smf::parse(&bytes).unwrap();
        let mut program = None;
        let mut keys = Vec::new();
        for event in &smf.tracks[1] {
            if let TrackEventKind::Midi { message, .. } = event.kind {
                match message {
                    Mm::ProgramChange { program: p } => program = Some(p.as_int() + 1),
                    Mm::NoteOn { key, .. } => keys.push(key.as_int()),
                    _ => {}
                }
            }
        }
        assert_eq!(program, p.midi_program);
        assert_eq!(keys, vec![96, 36, 61]);
    }
}
