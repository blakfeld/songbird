//! Task 4.7's "same bad draft, identical normalization from each provider":
//! each real transport is fed the same messy draft and must yield the same pattern.

mod common;

use common::{request, request_for, FakeCodex, BAD_DRAFT, BAD_PIANO_DRAFT};
use music::ai::lyrics::lyrics_schema;
use music::ai::{
    ClaudeProvider, CodexCliProvider, MockProvider, OllamaProvider, OpenAiProvider,
    SchemaLyricsProvider, SchemaProvider,
};
use music::generate::generate_pattern;
use music::lyrics::assist_lyrics;
use music::GenerateRequest;
use secrecy::SecretString;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn draft_value(draft: &str) -> Value {
    serde_json::from_str(draft).unwrap()
}

async fn claude_pattern(draft: &str, request: &GenerateRequest) -> music::Pattern {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "content": [{"type": "tool_use", "name": "emit_pattern", "input": draft_value(draft)}]
        })))
        .mount(&server)
        .await;
    let provider = SchemaProvider::new(
        ClaudeProvider::new(SecretString::from("k"), "m").with_base_url(server.uri()),
    );
    generate_pattern(&provider, request).await.unwrap()
}

async fn openai_pattern(draft: &str, request: &GenerateRequest) -> music::Pattern {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{"message": {"role": "assistant", "content": draft}, "finish_reason": "stop"}]
        })))
        .mount(&server)
        .await;
    let provider = SchemaProvider::new(
        OpenAiProvider::new(SecretString::from("k"), "m").with_base_url(server.uri()),
    );
    generate_pattern(&provider, request).await.unwrap()
}

async fn ollama_pattern(draft: &str, request: &GenerateRequest) -> music::Pattern {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "message": {"role": "assistant", "content": draft}
        })))
        .mount(&server)
        .await;
    let provider = SchemaProvider::new(OllamaProvider::new(server.uri(), "m"));
    generate_pattern(&provider, request).await.unwrap()
}

async fn codex_pattern(draft: &str, request: &GenerateRequest) -> music::Pattern {
    let fake = FakeCodex::new("ok", draft);
    let provider = SchemaProvider::new(CodexCliProvider::new(fake.bin(), None));
    generate_pattern(&provider, request).await.unwrap()
}

#[tokio::test]
async fn every_provider_normalizes_the_same_bad_draft_identically() {
    let req = request("messy", 4);
    let claude = claude_pattern(BAD_DRAFT, &req).await;
    assert_eq!(claude, ollama_pattern(BAD_DRAFT, &req).await);
    assert_eq!(claude, codex_pattern(BAD_DRAFT, &req).await);
    assert_eq!(claude, openai_pattern(BAD_DRAFT, &req).await);

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

#[tokio::test]
async fn every_provider_normalizes_the_same_bad_melodic_draft_identically() {
    let req = request_for("piano", "messy", 4);
    let claude = claude_pattern(BAD_PIANO_DRAFT, &req).await;
    assert_eq!(claude, ollama_pattern(BAD_PIANO_DRAFT, &req).await);
    assert_eq!(claude, codex_pattern(BAD_PIANO_DRAFT, &req).await);
    assert_eq!(claude, openai_pattern(BAD_PIANO_DRAFT, &req).await);

    assert_eq!(claude.name, "Messy Keys");
    assert_eq!(claude.midi_program, Some(1));
    assert_eq!(claude.rows.len(), 61);
    let at = |row: &str, step| {
        claude
            .notes
            .iter()
            .filter(|n| n.row_id == row && n.step == step)
            .collect::<Vec<_>>()
    };
    let c4 = at("C4", 0);
    assert_eq!(c4.len(), 1);
    assert_eq!(c4[0].velocity, 127);
    assert_eq!(at("E6", 0)[0].length_steps, 4);
    assert_eq!(at("A#3", 2)[0].length_steps, 2);
    assert!(claude.notes.iter().all(|n| claude.row(&n.row_id).is_some()));
    assert_eq!(claude.notes.len(), 3 * 4);
}

fn lyrics_request() -> music::ai::LyricsRequest {
    music::ai::LyricsRequest {
        user: "<song>\n</song>".into(),
        section_ids: vec!["verse-1".into(), "chorus-1".into()],
        has_selection: false,
        latest_user_message: "a chorus".into(),
    }
}

const LYRICS_DRAFT: &str = r#"{"reply": "Try this.", "suggestions": [
    {"label": "Chorus", "text": "Take me home", "action": "replace_section", "section_id": "chorus-1"},
    {"label": "Bad", "text": "x", "action": "replace_section", "section_id": "nope"}
]}"#;

fn assert_lyrics_response(response: &music::lyrics::LyricsAssistResponse) {
    assert_eq!(response.reply, "Try this.");
    assert_eq!(response.suggestions.len(), 1);
    assert_eq!(response.suggestions[0].id, "s1");
    assert_eq!(
        response.suggestions[0].section_id.as_deref(),
        Some("chorus-1")
    );
}

#[tokio::test]
async fn lyrics_are_sent_to_claude_as_a_forced_tool_call_with_the_lyrics_schema() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "content": [{
                "type": "tool_use",
                "name": "emit_lyrics_reply",
                "input": draft_value(LYRICS_DRAFT)
            }]
        })))
        .mount(&server)
        .await;
    let provider = SchemaLyricsProvider::new(
        ClaudeProvider::new(SecretString::from("k"), "m").with_base_url(server.uri()),
    );
    let request = lyrics_request();
    let response = assist_lyrics(&provider, &request).await.unwrap();
    assert_lyrics_response(&response);

    let sent: Value = server.received_requests().await.unwrap()[0]
        .body_json()
        .unwrap();
    assert_eq!(
        sent["tool_choice"],
        json!({"type": "tool", "name": "emit_lyrics_reply"})
    );
    assert_eq!(sent["tools"][0]["name"], "emit_lyrics_reply");
    assert_eq!(
        sent["tools"][0]["input_schema"],
        lyrics_schema(&request.section_ids)
    );
    assert_eq!(sent["messages"][0]["content"], "<song>\n</song>");
}

#[tokio::test]
async fn lyrics_are_sent_to_openai_as_strict_structured_output() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{
                "message": {"role": "assistant", "content": LYRICS_DRAFT},
                "finish_reason": "stop"
            }]
        })))
        .mount(&server)
        .await;
    let provider = SchemaLyricsProvider::new(
        OpenAiProvider::new(SecretString::from("k"), "m").with_base_url(server.uri()),
    );
    let request = lyrics_request();
    let response = assist_lyrics(&provider, &request).await.unwrap();
    assert_lyrics_response(&response);

    let sent: Value = server.received_requests().await.unwrap()[0]
        .body_json()
        .unwrap();
    let format = &sent["response_format"];
    assert_eq!(format["type"], "json_schema");
    assert_eq!(format["json_schema"]["strict"], true);
    assert_eq!(
        format["json_schema"]["schema"],
        lyrics_schema(&request.section_ids)
    );
}

#[tokio::test]
async fn ollama_and_codex_serve_the_same_lyrics_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "message": {"role": "assistant", "content": LYRICS_DRAFT}
        })))
        .mount(&server)
        .await;
    let ollama = SchemaLyricsProvider::new(OllamaProvider::new(server.uri(), "m"));
    assert_lyrics_response(&assist_lyrics(&ollama, &lyrics_request()).await.unwrap());

    let fake = FakeCodex::new("ok", LYRICS_DRAFT);
    let codex = SchemaLyricsProvider::new(CodexCliProvider::new(fake.bin(), None));
    assert_lyrics_response(&assist_lyrics(&codex, &lyrics_request()).await.unwrap());
}
