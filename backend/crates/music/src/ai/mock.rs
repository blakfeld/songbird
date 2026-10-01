use async_trait::async_trait;

use super::{PatternProvider, ProviderError};
use crate::context::bass_by_beat_at_range_start;
use crate::draft::{DraftLane, DraftSection, LaneSteps, PatternDraft};
use crate::instruments::pitch::{parse_pitch, pitch_name};
use crate::instruments::{Instrument, InstrumentKind};
use crate::request::GenerateRequest;

/// Deterministic and offline so tests and CI need no key, server, or model.
#[derive(Debug, Default, Clone, Copy)]
pub struct MockProvider;

/// `DefaultHasher` is not guaranteed stable across Rust releases, and the
/// mock's whole purpose is reproducible output.
fn stable_hash(request: &GenerateRequest) -> u64 {
    let key = format!(
        "{}|{}|{}|{}|{:?}|{:?}",
        request.instrument.id,
        request.prompt,
        request.measures,
        request.time_signature.as_str(),
        request.tempo_bpm,
        request.swing,
    );
    key.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// Lets end-to-end tests see context change the output without a model. Only
/// the first section is adjusted, and each beat's first note moves to the
/// nearest pitch with the bass's pitch class, folded into the instrument's range.
fn follow_bass(
    draft: &mut PatternDraft,
    bass: &[Option<i32>],
    instrument: &Instrument,
    steps_per_beat: u32,
) {
    let Some(range) = instrument.range else {
        return;
    };
    let Some(section) = draft.sections.first_mut() else {
        return;
    };
    for (beat, bass) in bass.iter().enumerate() {
        let Some(bass) = bass else { continue };
        let window = beat as u32 * steps_per_beat..(beat as u32 + 1) * steps_per_beat;
        let first = section
            .lanes
            .iter()
            .enumerate()
            .filter_map(|(lane, l)| {
                let LaneSteps::Pattern(steps) = &l.steps else {
                    return None;
                };
                let step = window.clone().find(|&s| {
                    matches!(steps.as_bytes().get(s as usize), Some(b'g' | b'x' | b'X'))
                })?;
                Some((step, parse_pitch(&l.lane)?, lane))
            })
            .min();
        let Some((step, pitch, lane)) = first else {
            continue;
        };
        let shift = (bass - pitch).rem_euclid(12);
        let target = if shift > 6 {
            pitch + shift - 12
        } else {
            pitch + shift
        };
        let Some(target) = range.fold(target) else {
            continue;
        };
        let name = pitch_name(target);
        if name == section.lanes[lane].lane {
            continue;
        }
        let (moved, hold_end) = take_note(&mut section.lanes[lane], step);
        put_note(section, &name, step, moved, hold_end);
    }
}

/// The hold run moves with its onset, because leaving it behind would turn the
/// note's sustain into a stray rest-then-hold sequence on the old lane.
fn take_note(lane: &mut DraftLane, step: u32) -> (u8, u32) {
    let LaneSteps::Pattern(steps) = &mut lane.steps else {
        unreachable!("only step strings are selected");
    };
    let mut bytes = steps.clone().into_bytes();
    let onset = bytes[step as usize];
    let mut end = step as usize + 1;
    bytes[step as usize] = b'.';
    while bytes.get(end) == Some(&b'-') {
        bytes[end] = b'.';
        end += 1;
    }
    *steps = String::from_utf8(bytes).expect("ASCII step strings stay ASCII");
    (onset, end as u32)
}

fn put_note(section: &mut DraftSection, lane: &str, step: u32, onset: u8, hold_end: u32) {
    let spm = section
        .lanes
        .iter()
        .find_map(|l| match &l.steps {
            LaneSteps::Pattern(s) => Some(s.len()),
            LaneSteps::Velocities(_) => None,
        })
        .unwrap_or(0);
    let index = match section.lanes.iter().position(|l| l.lane == lane) {
        Some(i) => i,
        None => {
            section.lanes.push(DraftLane {
                lane: lane.to_string(),
                steps: LaneSteps::Pattern(".".repeat(spm)),
            });
            section.lanes.len() - 1
        }
    };
    if let LaneSteps::Pattern(steps) = &mut section.lanes[index].steps {
        let mut bytes = steps.clone().into_bytes();
        bytes[step as usize] = onset;
        for hold in step + 1..hold_end {
            bytes[hold as usize] = b'-';
        }
        *steps = String::from_utf8(bytes).expect("ASCII step strings stay ASCII");
    }
}

#[async_trait]
impl PatternProvider for MockProvider {
    async fn generate(
        &self,
        request: &GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        let prompt = request.prompt.to_lowercase();
        let by_keyword = instrument
            .examples
            .iter()
            .find(|e| e.keywords.iter().any(|k| prompt.contains(k)));
        let example = by_keyword
            .or_else(|| {
                let index = stable_hash(request) as usize % instrument.examples.len();
                instrument.examples.get(index)
            })
            .ok_or_else(|| {
                ProviderError::Unavailable(format!(
                    "Instrument {} has no example drafts for the mock provider.",
                    instrument.id
                ))
            })?;
        let mut draft = example.draft();
        if instrument.kind == InstrumentKind::Melodic {
            if let Some(context) = &request.context {
                follow_bass(
                    &mut draft,
                    &bass_by_beat_at_range_start(context),
                    instrument,
                    request.time_signature.steps_per_beat(),
                );
            }
        }
        Ok(draft)
    }

    async fn check(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::drums::DRUMS;
    use crate::instruments::InstrumentRegistry;
    use crate::request::GenerateRequestBody;

    fn request(prompt: &str, measures: i64) -> GenerateRequest {
        GenerateRequestBody {
            instrument: "drums".into(),
            prompt: prompt.into(),
            measures,
            ..Default::default()
        }
        .validate(&InstrumentRegistry::builtin(), 256)
        .unwrap()
    }

    #[tokio::test]
    async fn identical_requests_yield_identical_drafts() {
        for prompt in ["something mysterious", "another vibe entirely", "trap hats"] {
            let a = MockProvider.generate(&request(prompt, 8), &DRUMS).await;
            let b = MockProvider.generate(&request(prompt, 8), &DRUMS).await;
            assert_eq!(a.unwrap(), b.unwrap());
        }
    }

    #[tokio::test]
    async fn genre_keyword_selects_the_matching_example() {
        for (prompt, name) in [
            ("a four on the floor house beat", "Four On The Floor"),
            ("dusty boom bap", "Dusty Boom Bap"),
            ("aggressive TRAP hats", "Trap Bounce"),
            ("driving rock groove", "Straight Rock"),
        ] {
            let draft = MockProvider
                .generate(&request(prompt, 4), &DRUMS)
                .await
                .unwrap();
            assert_eq!(draft.name, name, "{prompt}");
        }
    }

    #[tokio::test]
    async fn unmatched_prompts_spread_across_examples_by_hash() {
        let mut names = std::collections::HashSet::new();
        for i in 0..40 {
            let draft = MockProvider
                .generate(&request(&format!("vibe number {i}"), 4), &DRUMS)
                .await
                .unwrap();
            names.insert(draft.name);
        }
        assert!(names.len() > 1);
    }

    fn melodic_request(context: Option<&str>) -> GenerateRequest {
        let mut request = GenerateRequestBody {
            instrument: "piano".into(),
            prompt: "slow jazzy chords".into(),
            measures: 4,
            ..Default::default()
        }
        .validate(&InstrumentRegistry::builtin(), 256)
        .unwrap();
        request.context = context.map(str::to_string);
        request
    }

    fn bass_context(pitch: &str) -> String {
        format!(
            "Target track: \"Keys\" (piano), writing measures 1-4\nTrack \"Bass\" (bass):\n\
             m1 b1: {pitch} (bass {pitch}) | b2: {pitch} (bass {pitch}) | b3: {pitch} (bass {pitch}) | b4: {pitch} (bass {pitch})"
        )
    }

    async fn melodic_draft(context: Option<&str>) -> PatternDraft {
        let request = melodic_request(context);
        MockProvider
            .generate(&request, request.instrument)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn melodic_output_with_context_is_deterministic() {
        let context = bass_context("A2");
        assert_eq!(
            melodic_draft(Some(&context)).await,
            melodic_draft(Some(&context)).await
        );
    }

    #[tokio::test]
    async fn changing_the_bass_in_the_context_changes_the_melodic_output() {
        let low_c = melodic_draft(Some(&bass_context("C2"))).await;
        let f_sharp = melodic_draft(Some(&bass_context("F#2"))).await;
        assert_ne!(low_c, f_sharp);
    }

    #[tokio::test]
    async fn bass_following_keeps_the_draft_usable() {
        let request = melodic_request(Some(&bass_context("G#3")));
        let draft = melodic_draft(request.context.as_deref()).await;
        let normalized = draft.normalize(request.instrument, 16).unwrap();
        assert!(!normalized.sections[0].is_empty());
    }

    #[tokio::test]
    async fn drums_ignore_context() {
        let mut request = request("rock", 4);
        let without = MockProvider.generate(&request, &DRUMS).await.unwrap();
        request.context = Some(bass_context("C2"));
        assert_eq!(
            MockProvider.generate(&request, &DRUMS).await.unwrap(),
            without
        );
    }
}
