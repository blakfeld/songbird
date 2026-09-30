use async_trait::async_trait;

use super::{PatternProvider, ProviderError};
use crate::draft::PatternDraft;
use crate::instruments::Instrument;
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
        request.measures.get(),
        request.time_signature.as_str(),
        request.tempo_bpm,
        request.swing,
    );
    key.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
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
        Ok(example.draft())
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
}
