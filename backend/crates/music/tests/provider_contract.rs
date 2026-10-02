//! Task 4.7's "same bad draft, identical normalization from each provider":
//! each real transport is fed the same messy draft and must yield the same pattern.

mod common;

use common::{request, request_for, FakeCodex, BAD_DRAFT, BAD_PIANO_DRAFT};
use music::ai::lyrics::lyrics_schema;
use music::ai::{
    ClaudeProvider, CodexCliProvider, MockProvider, OllamaProvider, OpenAiProvider, ProviderError,
    SchemaLyricsProvider, SchemaProvider, StructuredProvider, StructuredRequest, TextSink,
};
use music::generate::generate_pattern;
use music::lyrics::assist_lyrics;
use music::GenerateRequest;
use secrecy::SecretString;
use serde_json::{json, Value};
use std::sync::Arc;
use wiremock::matchers::{body_partial_json, method, path};
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

const FRAGMENT_CHARS: usize = 7;

fn fragments_of(draft: &str) -> Vec<String> {
    let chars: Vec<char> = draft.chars().collect();
    chars
        .chunks(FRAGMENT_CHARS)
        .map(|c| c.iter().collect())
        .collect()
}

fn structured_request() -> StructuredRequest {
    StructuredRequest {
        system: "s".into(),
        user: "u".into(),
        schema: json!({"type": "object"}),
        tool_name: "emit_pattern".into(),
        tool_description: "d".into(),
    }
}

fn claude_stream_body(fragments: &[String]) -> String {
    let event = |name: &str, data: Value| format!("event: {name}\ndata: {data}\n\n");
    let mut body = event(
        "content_block_start",
        json!({"type": "content_block_start", "index": 0,
            "content_block": {"type": "tool_use", "id": "t", "name": "emit_pattern", "input": {}}}),
    );
    for fragment in fragments {
        body += &event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": fragment}}),
        );
    }
    body + &event("message_stop", json!({"type": "message_stop"}))
}

fn openai_stream_body(fragments: &[String]) -> String {
    let chunk = |delta: Value, finish: Value| {
        format!(
            "data: {}\n\n",
            json!({"choices": [{"delta": delta, "finish_reason": finish}]})
        )
    };
    let mut body: String = fragments
        .iter()
        .map(|f| chunk(json!({"content": f}), Value::Null))
        .collect();
    body += &chunk(json!({}), json!("stop"));
    body + "data: [DONE]\n\n"
}

fn ollama_stream_body(fragments: &[String]) -> String {
    let line = |content: &str, done: bool| {
        format!(
            "{}\n",
            json!({"message": {"role": "assistant", "content": content}, "done": done})
        )
    };
    let body: String = fragments.iter().map(|f| line(f, false)).collect();
    body + &line("", true)
}

/// Both methods are served by one fake so a transport cannot pass by agreeing with itself
/// on only one of them.
async fn both_methods(transport: &dyn StructuredProvider, expected_text: &str) -> (Value, Value) {
    let buffered = transport.generate(&structured_request()).await.unwrap();
    let seen = std::sync::Mutex::new(String::new());
    let push = |fragment: &str| seen.lock().unwrap().push_str(fragment);
    let streamed = transport
        .generate_streaming(&structured_request(), &TextSink::new(&push))
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), expected_text);
    (buffered, streamed)
}

/// Routes the buffered entry point through the streaming one, so the whole pattern pipeline
/// can be compared across both methods.
struct ViaStreaming<T>(T);

#[async_trait::async_trait]
impl<T: StructuredProvider> StructuredProvider for ViaStreaming<T> {
    fn name(&self) -> &'static str {
        self.0.name()
    }

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError> {
        self.0
            .generate_streaming(request, &TextSink::discard())
            .await
    }

    async fn check(&self) -> Result<(), ProviderError> {
        self.0.check().await
    }
}

#[tokio::test]
async fn every_transport_gives_the_same_value_from_generate_and_generate_streaming() {
    let fragments = fragments_of(BAD_DRAFT);
    let value = draft_value(BAD_DRAFT);
    let expected_text = fragments.concat();
    let stream_only = || body_partial_json(json!({"stream": true}));

    let claude_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(stream_only())
        .respond_with(ResponseTemplate::new(200).set_body_string(claude_stream_body(&fragments)))
        .mount(&claude_server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "content": [{"type": "tool_use", "name": "emit_pattern", "input": value}]
        })))
        .mount(&claude_server)
        .await;
    let claude =
        ClaudeProvider::new(SecretString::from("k"), "m").with_base_url(claude_server.uri());

    let openai_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(stream_only())
        .respond_with(ResponseTemplate::new(200).set_body_string(openai_stream_body(&fragments)))
        .mount(&openai_server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{"message": {"role": "assistant", "content": BAD_DRAFT}, "finish_reason": "stop"}]
        })))
        .mount(&openai_server)
        .await;
    let openai =
        OpenAiProvider::new(SecretString::from("k"), "m").with_base_url(openai_server.uri());

    let ollama_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .and(stream_only())
        .respond_with(ResponseTemplate::new(200).set_body_string(ollama_stream_body(&fragments)))
        .mount(&ollama_server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "message": {"role": "assistant", "content": BAD_DRAFT}
        })))
        .mount(&ollama_server)
        .await;
    let ollama = OllamaProvider::new(ollama_server.uri(), "m");

    let transports: [Arc<dyn StructuredProvider>; 3] =
        [Arc::new(claude), Arc::new(openai), Arc::new(ollama)];
    let req = request("messy", 4);
    let mut patterns = Vec::new();
    for transport in transports {
        let (buffered, streamed) = both_methods(transport.as_ref(), &expected_text).await;
        assert_eq!(buffered, value, "{}", transport.name());
        assert_eq!(streamed, value, "{}", transport.name());
        let direct = generate_pattern(&SchemaProvider::new(transport.clone()), &req)
            .await
            .unwrap();
        let via_stream =
            generate_pattern(&SchemaProvider::new(ViaStreaming(transport.clone())), &req)
                .await
                .unwrap();
        assert_eq!(direct, via_stream, "{}", transport.name());
        patterns.push(direct);
    }
    assert!(patterns.windows(2).all(|w| w[0] == w[1]));
}

#[tokio::test]
async fn a_transport_that_cannot_stream_emits_no_text_but_returns_the_same_value() {
    let fake = FakeCodex::new("ok", BAD_DRAFT);
    let codex = CodexCliProvider::new(fake.bin(), None);
    let (buffered, streamed) = both_methods(&codex, "").await;
    assert_eq!(buffered, draft_value(BAD_DRAFT));
    assert_eq!(streamed, buffered);
}
