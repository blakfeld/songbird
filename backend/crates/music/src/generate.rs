use crate::ai::{PatternProvider, ProviderError};
use crate::context::render_context;
use crate::draft::{DraftError, NormalizedDraft};
use crate::expand::{build_notes, build_pattern, GenerationSpan};
use crate::pattern::Pattern;
use crate::request::GenerateRequest;
use crate::track_generation::{TrackGenerateResponse, ValidTrackRequest};

pub(crate) const ATTEMPTS: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum GenerationError {
    #[error("provider failed: {0}")]
    Provider(#[from] ProviderError),
    #[error("draft was unusable after {ATTEMPTS} attempts: {0}")]
    InvalidDraft(#[from] DraftError),
}

/// The one place a provider's draft becomes returned notes, so validation is
/// identical whichever provider or instrument produced it. Only unusable
/// drafts are retried: models often succeed on a second try, whereas transport
/// failures are unlikely to and would double the wait.
async fn normalized_draft(
    provider: &dyn PatternProvider,
    request: &GenerateRequest,
) -> Result<NormalizedDraft, GenerationError> {
    let steps_per_measure = request.time_signature.steps_per_measure();
    let mut last_error = None;
    for attempt in 1..=ATTEMPTS {
        let draft = match provider.generate(request, request.instrument).await {
            Ok(draft) => draft,
            Err(ProviderError::InvalidOutput(message)) => {
                tracing::warn!(attempt, %message, "provider output was unparseable");
                last_error = Some(GenerationError::Provider(ProviderError::InvalidOutput(
                    message,
                )));
                continue;
            }
            Err(other) => return Err(other.into()),
        };
        match draft.normalize(request.instrument, steps_per_measure) {
            Ok(normalized) => return Ok(normalized),
            Err(e) => {
                tracing::warn!(attempt, error = %e, "draft failed validation");
                last_error = Some(e.into());
            }
        }
    }
    Err(last_error.expect("at least one attempt ran"))
}

pub async fn generate_pattern(
    provider: &dyn PatternProvider,
    request: &GenerateRequest,
) -> Result<Pattern, GenerationError> {
    let draft = normalized_draft(provider, request).await?;
    Ok(build_pattern(&draft, request))
}

/// The song owns tempo, meter, swing and key, so the draft's own tempo and
/// swing are discarded and only its notes are used. Notes are returned relative
/// to the range start so the caller can store them as a loop without an offset.
pub async fn generate_track(
    provider: &dyn PatternProvider,
    request: &ValidTrackRequest<'_>,
    max_context_tokens: u32,
) -> Result<TrackGenerateResponse, GenerationError> {
    let song = request.song.song;
    let target = &request.song.tracks[request.target];
    // Both constructors of `ValidTrackRequest` refuse audio and sampler
    // targets, so reaching this with one is a programming error rather than
    // bad input.
    let instrument = target
        .instrument
        .instrument()
        .expect("generation targets are always registry instruments");
    let context = render_context(
        &request.song,
        request.target,
        request.range,
        max_context_tokens,
    );
    let generate_request = GenerateRequest {
        instrument,
        prompt: request.prompt.clone(),
        measures: request.range.measures(),
        tempo_bpm: Some(song.tempo_bpm),
        time_signature: song.time_signature,
        swing: Some(song.swing),
        context: Some(context).filter(|c| !c.is_empty()),
    };
    let draft = normalized_draft(provider, &generate_request).await?;
    let span = GenerationSpan::new(request.range.measures(), song.steps_per_measure)
        .expect("validated ranges are 1-32 measures");
    Ok(TrackGenerateResponse {
        track_id: target.track.id.clone(),
        range: request.range,
        notes: build_notes(&draft, span, instrument),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft::PatternDraft;
    use crate::instruments::{Instrument, InstrumentRegistry};
    use crate::request::GenerateRequestBody;
    use crate::track_generation::MeasureRange;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Mutex;

    struct Scripted(Mutex<Vec<Result<PatternDraft, ProviderError>>>);

    #[async_trait]
    impl PatternProvider for Scripted {
        async fn generate(
            &self,
            _: &GenerateRequest,
            _: &Instrument,
        ) -> Result<PatternDraft, ProviderError> {
            self.0.lock().unwrap().remove(0)
        }
        async fn check(&self) -> Result<(), ProviderError> {
            Ok(())
        }
    }

    fn request() -> GenerateRequest {
        GenerateRequestBody {
            instrument: "drums".into(),
            prompt: "x".into(),
            measures: 4,
            ..Default::default()
        }
        .validate(&InstrumentRegistry::builtin(), 256)
        .unwrap()
    }

    fn good() -> PatternDraft {
        PatternDraft::from_json(json!({
            "name": "g", "sections": [{"id": "A", "lanes": [{"lane": "kick", "steps": "x"}]}],
            "arrangement": ["A"]
        }))
        .unwrap()
    }

    fn empty() -> PatternDraft {
        PatternDraft::from_json(json!({"name": "e", "sections": [], "arrangement": []})).unwrap()
    }

    #[tokio::test]
    async fn retries_once_after_an_invalid_draft() {
        let provider = Scripted(Mutex::new(vec![Ok(empty()), Ok(good())]));
        let pattern = generate_pattern(&provider, &request()).await.unwrap();
        assert_eq!(pattern.name, "g");
    }

    #[tokio::test]
    async fn retries_once_after_unparseable_output() {
        let provider = Scripted(Mutex::new(vec![
            Err(ProviderError::InvalidOutput("junk".into())),
            Ok(good()),
        ]));
        assert!(generate_pattern(&provider, &request()).await.is_ok());
    }

    #[tokio::test]
    async fn fails_after_two_bad_attempts() {
        let provider = Scripted(Mutex::new(vec![Ok(empty()), Ok(empty()), Ok(good())]));
        assert!(generate_pattern(&provider, &request()).await.is_err());
        assert_eq!(provider.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn transport_errors_are_not_retried() {
        let provider = Scripted(Mutex::new(vec![
            Err(ProviderError::Request("down".into())),
            Ok(good()),
        ]));
        assert!(generate_pattern(&provider, &request()).await.is_err());
        assert_eq!(provider.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn key_errors_are_not_retried() {
        for error in [
            ProviderError::Unauthorized,
            ProviderError::QuotaExhausted,
            ProviderError::RateLimited { retry_after: None },
        ] {
            let provider = Scripted(Mutex::new(vec![Err(error.clone()), Ok(good())]));
            assert!(generate_pattern(&provider, &request()).await.is_err());
            assert_eq!(provider.0.lock().unwrap().len(), 1);
        }
    }

    use crate::song::tests::{song, track};
    use crate::track_generation::TrackGenerateBody;

    struct Recording {
        drafts: Mutex<Vec<Result<PatternDraft, ProviderError>>>,
        seen: Mutex<Vec<GenerateRequest>>,
    }

    impl Recording {
        fn new(drafts: Vec<Result<PatternDraft, ProviderError>>) -> Self {
            Self {
                drafts: Mutex::new(drafts),
                seen: Mutex::new(vec![]),
            }
        }
    }

    #[async_trait]
    impl PatternProvider for Recording {
        async fn generate(
            &self,
            request: &GenerateRequest,
            _: &Instrument,
        ) -> Result<PatternDraft, ProviderError> {
            self.seen.lock().unwrap().push(request.clone());
            self.drafts.lock().unwrap().remove(0)
        }
        async fn check(&self) -> Result<(), ProviderError> {
            Ok(())
        }
    }

    fn loud_kick() -> PatternDraft {
        PatternDraft::from_json(json!({
            "name": "g", "tempo_bpm": 200, "swing": 0.7,
            "sections": [{"id": "A", "lanes": [{"lane": "kick", "steps": [200, 0, 0, 0, 90]}]}],
            "arrangement": ["A"]
        }))
        .unwrap()
    }

    fn body(range: Option<(u32, u32)>) -> TrackGenerateBody {
        let s = song(16, vec![track("d", "Drums", "drums")]);
        TrackGenerateBody {
            song: s,
            track_id: "d".into(),
            prompt: "punchy".into(),
            range: range.map(|(start_measure, end_measure)| MeasureRange {
                start_measure,
                end_measure,
            }),
        }
    }

    async fn generate(
        provider: &Recording,
        range: (u32, u32),
    ) -> Result<TrackGenerateResponse, GenerationError> {
        let body = body(Some(range));
        let request = body.validate(&InstrumentRegistry::builtin(), 256).unwrap();
        generate_track(provider, &request, 4000).await
    }

    #[tokio::test]
    async fn track_velocity_above_127_is_clamped() {
        let provider = Recording::new(vec![Ok(loud_kick())]);
        let response = generate(&provider, (5, 8)).await.unwrap();
        assert_eq!(response.track_id, "d");
        assert_eq!(response.notes[0].velocity, 127);
    }

    #[tokio::test]
    async fn track_generation_retries_once_then_fails() {
        let provider = Recording::new(vec![Ok(empty()), Ok(empty()), Ok(loud_kick())]);
        assert!(generate(&provider, (1, 4)).await.is_err());
        assert_eq!(provider.seen.lock().unwrap().len(), 2);

        let provider = Recording::new(vec![Ok(empty()), Ok(loud_kick())]);
        assert!(generate(&provider, (1, 4)).await.is_ok());
    }

    #[tokio::test]
    async fn track_notes_stay_inside_the_range_and_start_at_zero() {
        for measures in [1, 5, 7] {
            let provider = Recording::new(vec![Ok(loud_kick())]);
            let response = generate(&provider, (5, 4 + measures)).await.unwrap();
            let total = measures * 16;
            assert!(!response.notes.is_empty());
            assert!(response
                .notes
                .iter()
                .all(|n| n.step + n.length_steps <= total));
            assert_eq!(response.notes.iter().map(|n| n.step).min(), Some(0));
        }
    }

    #[tokio::test]
    async fn song_settings_replace_the_drafts_and_the_range_sets_the_span() {
        let provider = Recording::new(vec![Ok(loud_kick())]);
        generate(&provider, (5, 8)).await.unwrap();
        let seen = provider.seen.lock().unwrap();
        assert_eq!(seen[0].measures, 4);
        assert_eq!(seen[0].tempo_bpm, Some(96));
        assert_eq!(seen[0].swing, Some(0.0));
        assert!(seen[0].context.as_deref().unwrap().contains("96 BPM"));
    }

    #[tokio::test]
    async fn a_zero_context_budget_sends_no_context() {
        let provider = Recording::new(vec![Ok(loud_kick())]);
        let body = body(None);
        let request = body.validate(&InstrumentRegistry::builtin(), 256).unwrap();
        generate_track(&provider, &request, 0).await.unwrap();
        assert_eq!(provider.seen.lock().unwrap()[0].context, None);
    }
}
