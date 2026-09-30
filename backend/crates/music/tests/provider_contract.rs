//! Task 4.7's "same bad draft, identical normalization from each provider":
//! each real transport is fed the same messy draft and must yield the same pattern.

mod common;

use common::{request, FakeCodex, BAD_DRAFT};
use music::ai::{ClaudeProvider, CodexCliProvider, MockProvider, OllamaProvider, SchemaProvider};
use music::generate::generate_pattern;
use secrecy::SecretString;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn bad_draft() -> Value {
    serde_json::from_str(BAD_DRAFT).unwrap()
}

async fn claude_pattern() -> music::Pattern {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "content": [{"type": "tool_use", "name": "emit_pattern", "input": bad_draft()}]
        })))
        .mount(&server)
        .await;
    let provider = SchemaProvider::new(
        ClaudeProvider::new(SecretString::from("k"), "m").with_base_url(server.uri()),
    );
    generate_pattern(&provider, &request("messy", 4))
        .await
        .unwrap()
}

async fn ollama_pattern() -> music::Pattern {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "message": {"role": "assistant", "content": BAD_DRAFT}
        })))
        .mount(&server)
        .await;
    let provider = SchemaProvider::new(OllamaProvider::new(server.uri(), "m"));
    generate_pattern(&provider, &request("messy", 4))
        .await
        .unwrap()
}

async fn codex_pattern() -> music::Pattern {
    let fake = FakeCodex::new("ok", BAD_DRAFT);
    let provider = SchemaProvider::new(CodexCliProvider::new(fake.bin(), None));
    generate_pattern(&provider, &request("messy", 4))
        .await
        .unwrap()
}

#[tokio::test]
async fn every_provider_normalizes_the_same_bad_draft_identically() {
    let claude = claude_pattern().await;
    assert_eq!(claude, ollama_pattern().await);
    assert_eq!(claude, codex_pattern().await);

    assert_eq!(claude.name, "Messy Draft");
    assert_eq!(claude.tempo_bpm, 240);
    assert_eq!(claude.swing, 0.75);
    let kick = |step| {
        claude
            .notes
            .iter()
            .find(|n| n.row_id == "kick" && n.step == step)
    };
    // velocity 200 -> 127, and the duplicate quieter "bd" note is removed.
    assert_eq!(kick(0).unwrap().velocity, 127);
    assert_eq!(
        claude
            .notes
            .iter()
            .filter(|n| n.row_id == "kick" && n.step == 0)
            .count(),
        1
    );
    assert!(claude.notes.iter().all(|n| n.row_id != "cowbell"));
    let hat = claude
        .notes
        .iter()
        .find(|n| n.row_id == "hat_closed")
        .unwrap();
    assert_eq!(hat.length_steps, 2);
}

#[tokio::test]
async fn mock_output_passes_the_same_pipeline() {
    let p = generate_pattern(&MockProvider, &request("boom bap", 16))
        .await
        .unwrap();
    assert_eq!(p.measures.get(), 16);
}
