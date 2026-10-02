use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

use std::ops::ControlFlow;

use super::{
    http_client, read_json_capped, read_stream_capped, ProviderError, StructuredProvider,
    StructuredRequest, TextSink, DEFAULT_REQUEST_TIMEOUT,
};

/// Matches the Claude provider's output cap.
const NUM_PREDICT: u32 = 4096;
/// The startup probe only lists models, so a hung server should fail startup quickly.
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

pub struct OllamaProvider {
    client: Client,
    base_url: String,
    model: String,
}

impl OllamaProvider {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            client: http_client(DEFAULT_REQUEST_TIMEOUT),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            model: model.into(),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.client = http_client(timeout);
        self
    }

    fn unreachable(&self) -> ProviderError {
        ProviderError::Unavailable(format!(
            "Cannot reach Ollama at {}. Start it with `ollama serve` (or set SONGBIRD_OLLAMA_URL).",
            self.base_url
        ))
    }
}

impl OllamaProvider {
    /// Shared by both paths so status handling cannot drift between them.
    async fn send(
        &self,
        request: &StructuredRequest,
        stream: bool,
    ) -> Result<reqwest::Response, ProviderError> {
        // `format` makes Ollama constrain decoding to the schema, which keeps
        // small local models on-format.
        let body = json!({
            "model": self.model,
            "stream": stream,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
            "format": request.schema,
            // A model that never emits a stop token would otherwise generate until the timeout.
            "options": {"num_predict": NUM_PREDICT},
        });
        let response = self
            .client
            .post(format!("{}/api/chat", self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ProviderError::Request(format!(
                        "Ollama at {} did not respond in time. A cold model load can be slow; \
                         raise SONGBIRD_GENERATION_TIMEOUT_SECS.",
                        self.base_url
                    ))
                } else {
                    ProviderError::Request(self.unreachable().to_string())
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(ProviderError::Request(format!(
                "Ollama returned HTTP {status}"
            )));
        }
        Ok(response)
    }
}

/// Splits the NDJSON body on newlines at the byte level, because a chunk can end inside a
/// multi-byte character.
#[derive(Default)]
struct LineBuffer(Vec<u8>);

impl LineBuffer {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.0.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(end) = self.0.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.0.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line[..end]).trim().to_string();
            if !line.is_empty() {
                lines.push(line);
            }
        }
        lines
    }
}

#[derive(Default)]
struct ChatStream {
    content: String,
    done: bool,
}

impl ChatStream {
    fn handle(
        &mut self,
        line: &str,
        text: &TextSink<'_>,
    ) -> Result<ControlFlow<()>, ProviderError> {
        let chunk: Value = serde_json::from_str(line)
            .map_err(|_| ProviderError::InvalidOutput("stream line is not JSON".into()))?;
        if chunk.get("error").is_some() {
            // The message is dropped: it may echo request content.
            return Err(ProviderError::Request(
                "Ollama reported an error during the response".into(),
            ));
        }
        if let Some(fragment) = chunk["message"]["content"]
            .as_str()
            .filter(|c| !c.is_empty())
        {
            self.content.push_str(fragment);
            text.emit(fragment);
        }
        if chunk["done"].as_bool() == Some(true) {
            self.done = true;
            return Ok(ControlFlow::Break(()));
        }
        Ok(ControlFlow::Continue(()))
    }

    fn finish(self) -> Result<Value, ProviderError> {
        if !self.done {
            return Err(ProviderError::Request(
                "the Ollama stream ended before the response finished".into(),
            ));
        }
        if self.content.is_empty() {
            return Err(ProviderError::InvalidOutput(
                "response had no message content".into(),
            ));
        }
        serde_json::from_str(&self.content)
            .map_err(|e| ProviderError::InvalidOutput(format!("message is not JSON: {e}")))
    }
}

#[async_trait]
impl StructuredProvider for OllamaProvider {
    fn name(&self) -> &'static str {
        "ollama"
    }

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError> {
        let response = self.send(request, false).await?;
        let payload = read_json_capped(response).await?;
        let content = payload["message"]["content"].as_str().ok_or_else(|| {
            ProviderError::InvalidOutput("response had no message content".into())
        })?;
        serde_json::from_str(content)
            .map_err(|e| ProviderError::InvalidOutput(format!("message is not JSON: {e}")))
    }

    async fn generate_streaming(
        &self,
        request: &StructuredRequest,
        text: &TextSink<'_>,
    ) -> Result<Value, ProviderError> {
        let response = self.send(request, true).await?;
        let mut lines = LineBuffer::default();
        let mut stream = ChatStream::default();
        read_stream_capped(response, |chunk| {
            for line in lines.push(chunk) {
                if stream.handle(&line, text)?.is_break() {
                    return Ok(ControlFlow::Break(()));
                }
            }
            Ok(ControlFlow::Continue(()))
        })
        .await?;
        stream.finish()
    }

    async fn check(&self) -> Result<(), ProviderError> {
        let response = self
            .client
            .get(format!("{}/api/tags", self.base_url))
            .timeout(CHECK_TIMEOUT)
            .send()
            .await
            .map_err(|_| self.unreachable())?;
        if !response.status().is_success() {
            return Err(self.unreachable());
        }
        let tags = read_json_capped(response)
            .await
            .map_err(|_| self.unreachable())?;
        // Ollama lists untagged pulls as `name:latest`.
        let latest = format!("{}:latest", self.model);
        let installed = tags["models"].as_array().is_some_and(|models| {
            models
                .iter()
                .filter_map(|m| m["name"].as_str())
                .any(|name| name == self.model || name == latest)
        });
        if installed {
            Ok(())
        } else {
            Err(ProviderError::Unavailable(format!(
                "Ollama model {model} is not available on {url}. Run `ollama pull {model}`.",
                model = self.model,
                url = self.base_url
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn request() -> StructuredRequest {
        StructuredRequest {
            system: "sys".into(),
            user: "usr".into(),
            schema: json!({"type": "object"}),
            tool_name: "emit_pattern".into(),
            tool_description: "d".into(),
        }
    }

    #[tokio::test]
    async fn oversize_response_is_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b' '; 5 * 1024 * 1024]))
            .mount(&server)
            .await;
        let err = OllamaProvider::new(server.uri(), "m")
            .generate(&request())
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Request(m) if m.contains("limit")));
    }

    #[tokio::test]
    async fn slow_server_hits_the_request_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)))
            .mount(&server)
            .await;
        let err = OllamaProvider::new(server.uri(), "m")
            .with_timeout(Duration::from_millis(100))
            .generate(&request())
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Request(_)));
    }

    #[tokio::test]
    async fn parses_message_content_and_sends_schema_as_format() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "message": {"role": "assistant", "content": "{\"name\":\"ok\"}"}
            })))
            .mount(&server)
            .await;
        let provider = OllamaProvider::new(server.uri(), "m");
        assert_eq!(
            provider.generate(&request()).await.unwrap(),
            json!({"name": "ok"})
        );
        let sent: Value = server.received_requests().await.unwrap()[0]
            .body_json()
            .unwrap();
        assert_eq!(sent["stream"], false);
        assert_eq!(sent["format"], json!({"type": "object"}));
        assert_eq!(sent["model"], "m");
        assert_eq!(sent["messages"][0]["role"], "system");
        assert_eq!(sent["messages"][1]["content"], "usr");
    }

    #[tokio::test]
    async fn schema_violating_output_is_invalid_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "message": {"role": "assistant", "content": "sorry, here is prose"}
            })))
            .mount(&server)
            .await;
        let err = OllamaProvider::new(server.uri(), "m")
            .generate(&request())
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidOutput(_)));
    }

    #[tokio::test]
    async fn check_passes_when_model_is_listed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "models": [{"name": "other:7b"}, {"name": "qwen:latest"}]
            })))
            .mount(&server)
            .await;
        OllamaProvider::new(server.uri(), "qwen")
            .check()
            .await
            .unwrap();
        OllamaProvider::new(server.uri(), "qwen:latest")
            .check()
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn check_reports_missing_model_with_pull_command() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"models": []})))
            .mount(&server)
            .await;
        let err = OllamaProvider::new(server.uri(), "qwen2.5:7b-instruct")
            .check()
            .await
            .unwrap_err();
        assert!(err.to_string().contains("ollama pull qwen2.5:7b-instruct"));
    }

    #[tokio::test]
    async fn server_down_names_the_url_and_suggests_starting_it() {
        // A closed port can be reassigned to a parallel test's mock server, so hold the port
        // and hang up on every connection instead.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                drop(socket);
            }
        });
        let provider = OllamaProvider::new(url.clone(), "m");
        let err = provider.check().await.unwrap_err();
        assert!(err.to_string().contains(&url));
        assert!(err.to_string().contains("ollama serve"));
        let err = provider.generate(&request()).await.unwrap_err();
        assert!(matches!(err, ProviderError::Request(_)), "{err:?}");
    }

    mod streaming {
        use super::*;
        use std::sync::Mutex;

        fn line(content: &str, done: bool) -> String {
            format!(
                "{}\n",
                json!({"message": {"role": "assistant", "content": content}, "done": done})
            )
        }

        fn ndjson(fragments: &[&str]) -> String {
            let mut body: String = fragments.iter().map(|f| line(f, false)).collect();
            body += &line("", true);
            body
        }

        async fn run(response: ResponseTemplate) -> (Result<Value, ProviderError>, Vec<String>) {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/api/chat"))
                .respond_with(response)
                .mount(&server)
                .await;
            let seen = Mutex::new(Vec::new());
            let push = |fragment: &str| seen.lock().unwrap().push(fragment.to_string());
            let result = OllamaProvider::new(server.uri(), "m")
                .generate_streaming(&request(), &TextSink::new(&push))
                .await;
            (result, seen.into_inner().unwrap())
        }

        #[tokio::test]
        async fn fragments_reach_the_sink_in_order_and_the_value_matches_the_buffered_result() {
            let fragments = ["{\"na", "me\":\"o", "k\"}"];
            let (result, seen) =
                run(ResponseTemplate::new(200).set_body_string(ndjson(&fragments))).await;
            assert_eq!(seen, fragments);

            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "message": {"role": "assistant", "content": "{\"name\":\"ok\"}"}
                })))
                .mount(&server)
                .await;
            let buffered = OllamaProvider::new(server.uri(), "m")
                .generate(&request())
                .await
                .unwrap();
            assert_eq!(result.unwrap(), buffered);
        }

        #[tokio::test]
        async fn the_request_asks_for_a_stream_with_the_schema_format() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(200).set_body_string(ndjson(&["{}"])))
                .mount(&server)
                .await;
            OllamaProvider::new(server.uri(), "m")
                .generate_streaming(&request(), &TextSink::discard())
                .await
                .unwrap();
            let sent: Value = server.received_requests().await.unwrap()[0]
                .body_json()
                .unwrap();
            assert_eq!(sent["stream"], true);
            assert_eq!(sent["format"], json!({"type": "object"}));
        }

        #[tokio::test]
        async fn a_line_split_across_chunks_and_a_multibyte_character_are_reassembled() {
            let mut buffer = LineBuffer::default();
            let full = line("h\u{e9}llo", false);
            let bytes = full.as_bytes();
            let cut = full.find('\u{e9}').unwrap() + 1;
            assert!(buffer.push(&bytes[..cut]).is_empty());
            let lines = buffer.push(&bytes[cut..]);
            assert_eq!(lines.len(), 1);
            assert!(lines[0].contains("h\u{e9}llo"));
        }

        #[tokio::test]
        async fn http_errors_stay_generic_without_the_body() {
            for status in [401, 429, 500] {
                let (result, seen) =
                    run(ResponseTemplate::new(status).set_body_string("secret upstream detail"))
                        .await;
                let err = result.unwrap_err();
                assert!(matches!(err, ProviderError::Request(_)));
                assert!(err.to_string().contains(&status.to_string()));
                assert!(!err.to_string().contains("secret upstream detail"));
                assert!(seen.is_empty());
            }
        }

        #[tokio::test]
        async fn a_mid_stream_error_is_a_request_error_without_the_body() {
            let body = line("{\"na", false) + "{\"error\":\"SECRET-BODY-TEXT\"}\n";
            let (result, seen) = run(ResponseTemplate::new(200).set_body_string(body)).await;
            let err = result.unwrap_err();
            assert!(matches!(err, ProviderError::Request(_)));
            assert!(!err.to_string().contains("SECRET-BODY-TEXT"));
            assert_eq!(seen, ["{\"na"]);
        }

        #[tokio::test]
        async fn a_stream_without_done_is_a_request_error() {
            let (result, _) =
                run(ResponseTemplate::new(200).set_body_string(line("{}", false))).await;
            assert!(matches!(result.unwrap_err(), ProviderError::Request(_)));
        }

        #[tokio::test]
        async fn empty_and_non_json_content_are_invalid_output() {
            let (result, _) = run(ResponseTemplate::new(200).set_body_string(ndjson(&[]))).await;
            assert!(matches!(
                result.unwrap_err(),
                ProviderError::InvalidOutput(_)
            ));
            let (result, _) =
                run(ResponseTemplate::new(200).set_body_string(ndjson(&["nope"]))).await;
            assert!(matches!(
                result.unwrap_err(),
                ProviderError::InvalidOutput(_)
            ));
        }

        #[tokio::test]
        async fn an_oversize_stream_is_rejected() {
            let padding = "x".repeat(5 * 1024 * 1024);
            let (result, _) =
                run(ResponseTemplate::new(200).set_body_string(ndjson(&[padding.as_str()]))).await;
            assert!(
                matches!(result.unwrap_err(), ProviderError::Request(m) if m.contains("limit"))
            );
        }
    }
}
