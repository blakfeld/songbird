//! Ignored by default: each needs a real provider. Run through the justfile
//! recipes `test-live`, `test-live-ollama`, and `test-live-codex`.

mod common;

use common::request;
use music::ai::{
    ClaudeProvider, CodexCliProvider, OllamaProvider, PatternProvider, SchemaProvider,
};
use music::generate::generate_pattern;
use secrecy::SecretString;

fn env_or(var: &str, default: &str) -> String {
    std::env::var(var)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

async fn assert_generates(provider: &dyn PatternProvider) {
    provider.check().await.expect("provider check");
    let request = request("a laid back boom bap beat with ghost snares", 8);
    let pattern = generate_pattern(provider, &request)
        .await
        .expect("generation");
    assert_eq!(pattern.measures.get(), 8);
    assert_eq!(pattern.instrument, "drums");
    assert!(!pattern.notes.is_empty());
}

#[tokio::test]
#[ignore = "needs ANTHROPIC_API_KEY"]
async fn live_claude_generates_a_valid_pattern() {
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY must be set");
    let model = env_or("SONGBIRD_AI_MODEL", "claude-sonnet-5-5");
    assert_generates(&SchemaProvider::new(ClaudeProvider::new(
        SecretString::from(key),
        model,
    )))
    .await;
}

#[tokio::test]
#[ignore = "needs a running Ollama with the model pulled"]
async fn live_ollama_generates_a_valid_pattern() {
    let url = env_or("SONGBIRD_OLLAMA_URL", "http://localhost:11434");
    let model = env_or("SONGBIRD_OLLAMA_MODEL", "qwen2.5:7b-instruct");
    assert_generates(&SchemaProvider::new(OllamaProvider::new(url, model))).await;
}

#[tokio::test]
#[ignore = "needs a signed-in Codex CLI"]
async fn live_codex_generates_a_valid_pattern() {
    let bin = env_or("SONGBIRD_CODEX_BIN", "codex");
    let model = std::env::var("SONGBIRD_CODEX_MODEL")
        .ok()
        .filter(|m| !m.trim().is_empty());
    assert_generates(&SchemaProvider::new(CodexCliProvider::new(bin, model))).await;
}
