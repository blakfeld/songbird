//! An estimate instead of a real tokenizer: the cap only bounds cost and abuse,
//! it must be identical for every provider, and the browser has to mirror it
//! exactly (`frontend/src/lib/estimateTokens.ts`). Both implementations are pinned by
//! `fixtures/token_estimate.json` so they cannot drift.

pub const DEFAULT_MAX_INPUT_TOKENS: u32 = 256;
pub const MIN_MAX_INPUT_TOKENS: u32 = 16;
pub const MAX_MAX_INPUT_TOKENS: u32 = 4096;

/// Exactly the set JavaScript's `String.prototype.trim` strips. Rust's own
/// `trim` differs (it strips U+0085 but not U+FEFF), which would let the
/// browser and server disagree on the same prompt.
fn is_shared_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// Counts characters, not bytes, so non-Latin prompts are not penalized.
pub fn estimate_tokens(prompt: &str) -> u32 {
    let n = prompt.trim_matches(is_shared_whitespace).chars().count() as u32;
    n.div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        prompt: Option<String>,
        /// Boundary cases are ~1000 chars long; generating them keeps the fixture readable.
        unit: Option<String>,
        repeat: Option<usize>,
        prefix: Option<String>,
        suffix: Option<String>,
        expected: u32,
    }

    impl Case {
        fn prompt(&self) -> String {
            match (&self.prompt, &self.unit, self.repeat) {
                (Some(p), _, _) => p.clone(),
                (None, Some(u), Some(r)) => format!(
                    "{}{}{}",
                    self.prefix.as_deref().unwrap_or(""),
                    u.repeat(r),
                    self.suffix.as_deref().unwrap_or("")
                ),
                _ => panic!("fixture case {} has no prompt", self.name),
            }
        }
    }

    #[test]
    fn matches_shared_fixture() {
        let raw = include_str!("../../../../fixtures/token_estimate.json");
        let cases: Vec<Case> = serde_json::from_str(raw).unwrap();
        assert!(cases.len() >= 8);
        for case in cases {
            assert_eq!(
                estimate_tokens(&case.prompt()),
                case.expected,
                "case {}",
                case.name
            );
        }
    }
}
