use crate::ai::{PatternProvider, ProviderError};
use crate::draft::DraftError;
use crate::expand::build_pattern;
use crate::pattern::Pattern;
use crate::request::GenerateRequest;

const ATTEMPTS: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum GenerationError {
    #[error("provider failed: {0}")]
    Provider(#[from] ProviderError),
    #[error("draft was unusable after {ATTEMPTS} attempts: {0}")]
    InvalidDraft(#[from] DraftError),
}

/// The one place a provider's draft becomes a returned pattern, so validation
/// is identical whichever provider or instrument produced it. Only unusable
/// drafts are retried: models often succeed on a second try, whereas transport
/// failures are unlikely to and would double the wait.
pub async fn generate_pattern(
    provider: &dyn PatternProvider,
    request: &GenerateRequest,
) -> Result<Pattern, GenerationError> {
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
            Ok(normalized) => return Ok(build_pattern(&normalized, request)),
            Err(e) => {
                tracing::warn!(attempt, error = %e, "draft failed validation");
                last_error = Some(e.into());
            }
        }
    }
    Err(last_error.expect("at least one attempt ran"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft::PatternDraft;
    use crate::instruments::{Instrument, InstrumentRegistry};
    use crate::request::GenerateRequestBody;
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
}
