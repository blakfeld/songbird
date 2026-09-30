//! The frontend mirrors `step_to_seconds` (verified against `fixtures/timing.json`)
//! so playback and exported MIDI place every note at the same moment.

use crate::meter::STEPS_PER_QUARTER;

pub const PPQ: u32 = 480;

pub const TICKS_PER_STEP: u32 = PPQ / STEPS_PER_QUARTER;

fn swing_offset_steps(step: u32, swing: f64) -> f64 {
    if step % 2 == 1 {
        swing
    } else {
        0.0
    }
}

/// Saturating so a hostile step can never panic; export validates ranges first.
/// Ticks are integers, so the swing delay is rounded to the nearest tick; the
/// seconds variant stays exact because audio scheduling has no such grid.
pub fn step_to_ticks(step: u32, swing: f64) -> u32 {
    let swing_ticks = (swing_offset_steps(step, swing) * f64::from(TICKS_PER_STEP)).round() as u32;
    step.saturating_mul(TICKS_PER_STEP)
        .saturating_add(swing_ticks)
}

pub fn step_to_seconds(step: u32, tempo_bpm: u32, swing: f64) -> f64 {
    let sixteenth = 60.0 / f64::from(tempo_bpm) / f64::from(STEPS_PER_QUARTER);
    (f64::from(step) + swing_offset_steps(step, swing)) * sixteenth
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meter::TimeSignature;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixture {
        ppq: u32,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        tempo_bpm: u32,
        time_signature: TimeSignature,
        measures: u32,
        swing: f64,
        notes: Vec<NoteCase>,
        total_seconds: f64,
        total_ticks: u32,
    }

    #[derive(Deserialize)]
    struct NoteCase {
        step: u32,
        length_steps: u32,
        start_seconds: f64,
        end_seconds: f64,
        start_ticks: u32,
        end_ticks: u32,
    }

    fn close(actual: f64, expected: f64, context: &str) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "{context}: {actual} != {expected}"
        );
    }

    #[test]
    fn matches_shared_fixture() {
        let raw = include_str!("../../../../fixtures/timing.json");
        let fixture: Fixture = serde_json::from_str(raw).unwrap();
        assert_eq!(fixture.ppq, PPQ);
        for case in fixture.cases {
            let name = &case.name;
            for n in &case.notes {
                let end = n.step + n.length_steps;
                let at = |what: &str| format!("{name} step {} {what}", n.step);
                assert_eq!(
                    step_to_ticks(n.step, case.swing),
                    n.start_ticks,
                    "{}",
                    at("start ticks")
                );
                assert_eq!(
                    step_to_ticks(end, case.swing),
                    n.end_ticks,
                    "{}",
                    at("end ticks")
                );
                close(
                    step_to_seconds(n.step, case.tempo_bpm, case.swing),
                    n.start_seconds,
                    &at("start s"),
                );
                close(
                    step_to_seconds(end, case.tempo_bpm, case.swing),
                    n.end_seconds,
                    &at("end s"),
                );
            }
            let total_steps = case.measures * case.time_signature.steps_per_measure();
            assert_eq!(
                step_to_ticks(total_steps, case.swing),
                case.total_ticks,
                "{name} total ticks"
            );
            close(
                step_to_seconds(total_steps, case.tempo_bpm, case.swing),
                case.total_seconds,
                name,
            );
        }
    }

    #[test]
    fn huge_steps_saturate_instead_of_overflowing() {
        assert_eq!(step_to_ticks(u32::MAX, 0.75), u32::MAX);
        assert_eq!(step_to_ticks(u32::MAX - 1, 1e12), u32::MAX);
    }

    #[test]
    fn even_steps_ignore_swing() {
        assert_eq!(step_to_ticks(4, 0.75), 480);
        assert_eq!(step_to_ticks(5, 0.5), 5 * 120 + 60);
    }
}
