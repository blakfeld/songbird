use async_trait::async_trait;
use reqwest::Client;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use std::ops::ControlFlow;

use super::sse::SseParser;
use super::{
    http_client, probe_models, read_error_fields, read_json_capped, read_stream_capped,
    retry_after_secs, transport_error, ErrorFields, KeyCheckError, ProviderError,
    StructuredProvider, StructuredRequest, TextSink, DEFAULT_REQUEST_TIMEOUT,
};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// Pinned because the tool-use request shape is tied to an API version.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Bounds output cost: a compact draft for 32 measures fits well within this.
pub const DEFAULT_MAX_TOKENS: u32 = 4096;

/// Confirms a key without spending tokens or needing a model id, so a renamed model cannot
/// make a good key look bad. The client is passed in so callers share one connection pool.
pub async fn check_key(
    client: &Client,
    base_url: &str,
    api_key: &SecretString,
    timeout: Duration,
) -> Result<(), KeyCheckError> {
    probe_models(
        client
            .get(format!(
                "{}/v1/models?limit=1",
                base_url.trim_end_matches('/')
            ))
            .header("x-api-key", api_key.expose_secret())
            .header("anthropic-version", ANTHROPIC_VERSION),
        timeout,
    )
    .await
}

/// Every 429 is a rate limit by HTTP semantics, so it is classified even when the body is
/// unparseable and `retry-after` can still reach the user. A 400 `invalid_request_error` for a
/// spend limit is deliberately unclassified: only its message text identifies it, and message
/// text is never read.
fn classify_error(
    status: u16,
    fields: &ErrorFields,
    retry_after: Option<u64>,
) -> Option<ProviderError> {
    if status == 401
        || status == 403
        || fields.is_any_of(&["authentication_error", "permission_error"])
    {
        Some(ProviderError::Unauthorized)
    } else if status == 402 || fields.is_any_of(&["billing_error"]) {
        Some(ProviderError::QuotaExhausted)
    } else if status == 429 {
        Some(ProviderError::RateLimited { retry_after })
    } else {
        None
    }
}

pub struct ClaudeProvider {
    client: Client,
    base_url: String,
    api_key: SecretString,
    model: String,
    max_tokens: u32,
    forcing_unsupported: AtomicBool,
}

impl ClaudeProvider {
    pub fn new(api_key: SecretString, model: impl Into<String>) -> Self {
        Self {
            client: http_client(DEFAULT_REQUEST_TIMEOUT),
            base_url: DEFAULT_BASE_URL.into(),
            api_key,
            model: model.into(),
            max_tokens: DEFAULT_MAX_TOKENS,
            forcing_unsupported: AtomicBool::new(false),
        }
    }

    /// Lets tests point at a local fake server.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_string();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.client = http_client(timeout);
        self
    }

    /// Lets one pooled client serve every user's provider, since pools are per client.
    pub fn with_client(mut self, client: Client) -> Self {
        self.client = client;
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }
}

/// Kept apart from `ProviderError` so `send` can tell a 400 it may retry without
/// forcing the tool from every other failure.
struct PostFailure {
    error: ProviderError,
    invalid_request: bool,
}

impl ClaudeProvider {
    /// Shared by both paths so status handling cannot drift between them.
    ///
    /// Forcing the tool call is what makes the model return schema-shaped JSON, but
    /// some models (Sonnet 5.5) answer 400 to a forced `tool_choice`. The 400's
    /// message is never read, so any `invalid_request_error` on a forced request
    /// is retried once with `auto`, and the model is remembered as unable to be
    /// forced only after that retry succeeds.
    async fn send(
        &self,
        request: &StructuredRequest,
        stream: bool,
    ) -> Result<reqwest::Response, ProviderError> {
        let forced = !self.forcing_unsupported.load(Ordering::Relaxed);
        match self.post(request, stream, forced).await {
            Ok(response) => Ok(response),
            Err(failure) if forced && failure.invalid_request => {
                let response = self
                    .post(request, stream, false)
                    .await
                    .map_err(|retry| retry.error)?;
                self.forcing_unsupported.store(true, Ordering::Relaxed);
                Ok(response)
            }
            Err(failure) => Err(failure.error),
        }
    }

    async fn post(
        &self,
        request: &StructuredRequest,
        stream: bool,
        forced: bool,
    ) -> Result<reqwest::Response, PostFailure> {
        let (system, tool_choice) = if forced {
            (
                request.system.clone(),
                json!({"type": "tool", "name": request.tool_name}),
            )
        } else {
            // Without a forced call the model could answer in prose, so the
            // instruction moves into the prompt.
            (
                format!(
                    "{}\nRespond by calling the `{}` tool exactly once, with no other text.",
                    request.system, request.tool_name
                ),
                json!({"type": "auto"}),
            )
        };
        let mut body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": request.user}],
            "tools": [{
                "name": request.tool_name,
                "description": request.tool_description,
                "input_schema": request.schema,
            }],
            "tool_choice": tool_choice,
        });
        if stream {
            body["stream"] = json!(true);
        }
        let response = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", self.api_key.expose_secret())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| PostFailure {
                error: transport_error("Anthropic", &e),
                invalid_request: false,
            })?;

        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let retry_after = retry_after_secs(response.headers());
        let fields = read_error_fields(response).await;
        // Only the machine-readable type and code are logged: the message text may echo
        // request content.
        tracing::warn!(
            %status,
            kind = fields.kind.as_deref().unwrap_or("unknown"),
            code = fields.code.as_deref().unwrap_or("none"),
            forced,
            "the Anthropic API rejected a request"
        );
        let invalid_request =
            status.as_u16() == 400 && fields.is_any_of(&["invalid_request_error"]);
        let error = classify_error(status.as_u16(), &fields, retry_after).unwrap_or_else(|| {
            ProviderError::Request(format!("the Anthropic API returned HTTP {status}"))
        });
        Err(PostFailure {
            error,
            invalid_request,
        })
    }
}

/// The forced tool call's input only exists as fragments until `message_stop`, so it is
/// rebuilt here and parsed once, which keeps streaming and buffered results identical.
struct ToolStream<'a> {
    tool_name: &'a str,
    tool_block: Option<u64>,
    json: String,
    stopped: bool,
}

impl<'a> ToolStream<'a> {
    fn new(tool_name: &'a str) -> Self {
        Self {
            tool_name,
            tool_block: None,
            json: String::new(),
            stopped: false,
        }
    }

    fn handle(
        &mut self,
        data: &str,
        text: &TextSink<'_>,
    ) -> Result<ControlFlow<()>, ProviderError> {
        // Anthropic repeats the event type inside the data, so the SSE `event:` line is not read.
        let event: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::InvalidOutput("stream event is not JSON".into()))?;
        match event["type"].as_str() {
            Some("content_block_start") => {
                let block = &event["content_block"];
                if block["type"] == "tool_use" && block["name"] == self.tool_name {
                    self.tool_block = event["index"].as_u64();
                }
            }
            Some("content_block_delta") => {
                let delta = &event["delta"];
                let in_tool_block =
                    self.tool_block.is_some() && event["index"].as_u64() == self.tool_block;
                if in_tool_block && delta["type"] == "input_json_delta" {
                    if let Some(fragment) = delta["partial_json"].as_str() {
                        self.json.push_str(fragment);
                        text.emit(fragment);
                    }
                }
            }
            Some("message_stop") => {
                self.stopped = true;
                return Ok(ControlFlow::Break(()));
            }
            Some("error") => return Err(stream_error(&event["error"])),
            _ => {}
        }
        Ok(ControlFlow::Continue(()))
    }

    fn finish(self) -> Result<Value, ProviderError> {
        if !self.stopped {
            return Err(ProviderError::Request(
                "the Anthropic stream ended before the response finished".into(),
            ));
        }
        if self.tool_block.is_none() {
            return Err(ProviderError::InvalidOutput(format!(
                "response contained no {} tool call",
                self.tool_name
            )));
        }
        // A tool call with no input streams no fragments; the buffered API reports `{}` then.
        if self.json.is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&self.json)
            .map_err(|e| ProviderError::InvalidOutput(format!("tool input is not JSON: {e}")))
    }
}

/// Maps a mid-stream error to the error its HTTP status would have produced, because the
/// status line was already sent as 200 by then. Only the machine-readable type is read.
fn stream_error(error: &Value) -> ProviderError {
    let fields: ErrorFields = serde_json::from_value(error.clone()).unwrap_or_default();
    let status = match fields.kind.as_deref() {
        Some("authentication_error") => 401,
        Some("permission_error") => 403,
        Some("billing_error") => 402,
        Some("rate_limit_error") => 429,
        Some("overloaded_error") => 529,
        _ => 500,
    };
    classify_error(status, &fields, None).unwrap_or_else(|| {
        ProviderError::Request(format!(
            "the Anthropic API returned HTTP {status} mid-stream"
        ))
    })
}

impl std::fmt::Debug for ClaudeProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeProvider")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl StructuredProvider for ClaudeProvider {
    fn name(&self) -> &'static str {
        "claude"
    }

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError> {
        let response = self.send(request, false).await?;
        let payload = read_json_capped(response).await?;
        payload["content"]
            .as_array()
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|b| b["type"] == "tool_use" && b["name"] == request.tool_name.as_str())
            })
            .map(|block| block["input"].clone())
            .ok_or_else(|| {
                ProviderError::InvalidOutput(format!(
                    "response contained no {} tool call",
                    request.tool_name
                ))
            })
    }

    async fn generate_streaming(
        &self,
        request: &StructuredRequest,
        text: &TextSink<'_>,
    ) -> Result<Value, ProviderError> {
        let response = self.send(request, true).await?;
        let mut parser = SseParser::new();
        let mut stream = ToolStream::new(&request.tool_name);
        read_stream_capped(response, |chunk| {
            for event in parser.push(chunk) {
                if stream.handle(&event.data, text)?.is_break() {
                    return Ok(ControlFlow::Break(()));
                }
            }
            Ok(ControlFlow::Continue(()))
        })
        .await?;
        stream.finish()
    }

    async fn check(&self) -> Result<(), ProviderError> {
        // A network probe would cost tokens or need a separate endpoint; the
        // presence of a key is validated where the provider is configured.
        if self.api_key.expose_secret().trim().is_empty() {
            return Err(ProviderError::Unavailable(
                "ANTHROPIC_API_KEY is required when SONGBIRD_AI_PROVIDER=claude".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
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

    fn provider(server: &MockServer) -> ClaudeProvider {
        ClaudeProvider::new(SecretString::from("test-key"), "claude-test")
            .with_base_url(server.uri())
            .with_max_tokens(1234)
    }

    #[tokio::test]
    async fn oversize_response_is_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b' '; 5 * 1024 * 1024]))
            .mount(&server)
            .await;
        let err = provider(&server).generate(&request()).await.unwrap_err();
        assert!(matches!(err, ProviderError::Request(m) if m.contains("limit")));
    }

    #[tokio::test]
    async fn returns_tool_input_and_sends_forced_tool_call() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "test-key"))
            .and(header("anthropic-version", ANTHROPIC_VERSION))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [
                    {"type": "text", "text": "thinking"},
                    {"type": "tool_use", "name": "emit_pattern", "input": {"name": "ok"}}
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;

        let value = provider(&server).generate(&request()).await.unwrap();
        assert_eq!(value, json!({"name": "ok"}));

        let sent: Value = server.received_requests().await.unwrap()[0]
            .body_json()
            .unwrap();
        assert_eq!(sent["model"], "claude-test");
        assert_eq!(sent["max_tokens"], 1234);
        assert_eq!(sent["system"], "sys");
        assert_eq!(
            sent["tool_choice"],
            json!({"type": "tool", "name": "emit_pattern"})
        );
        assert_eq!(sent["tools"][0]["input_schema"], json!({"type": "object"}));
    }

    #[tokio::test]
    async fn missing_tool_call_is_invalid_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [{"type": "text", "text": "I refuse"}]
            })))
            .mount(&server)
            .await;
        let err = provider(&server).generate(&request()).await.unwrap_err();
        assert!(matches!(err, ProviderError::InvalidOutput(_)));
    }

    #[tokio::test]
    async fn non_json_body_is_invalid_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>"))
            .mount(&server)
            .await;
        let err = provider(&server).generate(&request()).await.unwrap_err();
        assert!(matches!(err, ProviderError::InvalidOutput(_)));
    }

    #[tokio::test]
    async fn a_model_that_rejects_a_forced_tool_is_retried_with_auto_and_remembered() {
        use wiremock::matchers::body_partial_json;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_partial_json(
                json!({"tool_choice": {"type": "tool", "name": "emit_pattern"}}),
            ))
            .respond_with(
                ResponseTemplate::new(400).set_body_json(anthropic_error("invalid_request_error")),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(body_partial_json(json!({"tool_choice": {"type": "auto"}})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [
                    {"type": "thinking", "thinking": ""},
                    {"type": "tool_use", "name": "emit_pattern", "input": {"ok": true}},
                ]
            })))
            .mount(&server)
            .await;
        let provider = provider(&server);

        let first = provider.generate(&request()).await.unwrap();
        let second = provider.generate(&request()).await.unwrap();

        assert_eq!(first, json!({"ok": true}));
        assert_eq!(second, first);
        let requests = server.received_requests().await.unwrap();
        // Forced then auto for the first call; the second goes straight to auto.
        assert_eq!(requests.len(), 3);
        let body: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert!(body["system"]
            .as_str()
            .unwrap()
            .contains("calling the `emit_pattern` tool"));
    }

    #[tokio::test]
    async fn a_400_that_auto_also_rejects_is_not_remembered_as_unforceable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(400).set_body_json(anthropic_error("invalid_request_error")),
            )
            .mount(&server)
            .await;
        let provider = provider(&server);
        assert!(provider.generate(&request()).await.is_err());
        assert!(provider.generate(&request()).await.is_err());
        let requests = server.received_requests().await.unwrap();
        let forced = requests
            .iter()
            .filter(|r| {
                let body: Value = serde_json::from_slice(&r.body).unwrap();
                body["tool_choice"]["type"] == "tool"
            })
            .count();
        assert_eq!(forced, 2);
    }

    #[tokio::test]
    async fn http_error_is_a_request_error_without_the_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(529).set_body_string("secret upstream detail"))
            .mount(&server)
            .await;
        let err = provider(&server).generate(&request()).await.unwrap_err();
        assert!(matches!(err, ProviderError::Request(_)));
        assert!(err.to_string().contains("529"));
        assert!(!err.to_string().contains("secret upstream detail"));
    }

    async fn error_from(status: u16, body: Value, retry_after: Option<&str>) -> ProviderError {
        let server = MockServer::start().await;
        let mut response = ResponseTemplate::new(status).set_body_json(body);
        if let Some(value) = retry_after {
            response = response.insert_header("retry-after", value);
        }
        Mock::given(method("POST"))
            .respond_with(response)
            .mount(&server)
            .await;
        provider(&server).generate(&request()).await.unwrap_err()
    }

    fn anthropic_error(kind: &str) -> Value {
        json!({"type": "error", "error": {"type": kind, "message": "SECRET-BODY-TEXT"}})
    }

    #[tokio::test]
    async fn auth_and_permission_errors_are_unauthorized() {
        for (status, kind) in [(401, "authentication_error"), (403, "permission_error")] {
            let err = error_from(status, anthropic_error(kind), None).await;
            assert_eq!(err, ProviderError::Unauthorized);
            assert!(!err.to_string().contains("SECRET-BODY-TEXT"));
        }
        let unparseable = error_from(401, json!("not an error object"), None).await;
        assert_eq!(unparseable, ProviderError::Unauthorized);
    }

    #[tokio::test]
    async fn billing_errors_are_quota_exhausted() {
        for status in [402, 400] {
            let err = error_from(status, anthropic_error("billing_error"), None).await;
            assert_eq!(err, ProviderError::QuotaExhausted);
        }
    }

    #[tokio::test]
    async fn rate_limits_carry_a_capped_retry_after_when_present() {
        let body = || anthropic_error("rate_limit_error");
        assert_eq!(
            error_from(429, body(), Some("20")).await,
            ProviderError::RateLimited {
                retry_after: Some(20)
            }
        );
        assert_eq!(
            error_from(429, body(), None).await,
            ProviderError::RateLimited { retry_after: None }
        );
        assert_eq!(
            error_from(429, body(), Some("999999")).await,
            ProviderError::RateLimited {
                retry_after: Some(3600)
            }
        );
    }

    #[tokio::test]
    async fn a_429_with_an_unparseable_body_is_still_rate_limited() {
        assert_eq!(
            error_from(429, json!("nope"), Some("7")).await,
            ProviderError::RateLimited {
                retry_after: Some(7)
            }
        );
    }

    #[tokio::test]
    async fn overload_and_spend_limit_stay_generic_without_the_body() {
        for (status, kind) in [(529, "overloaded_error"), (400, "invalid_request_error")] {
            let err = error_from(status, anthropic_error(kind), None).await;
            assert!(matches!(err, ProviderError::Request(_)), "{status}: {err}");
            assert!(!err.to_string().contains("SECRET-BODY-TEXT"));
        }
    }

    async fn check_with(server: &MockServer, timeout: Duration) -> Result<(), KeyCheckError> {
        let key = SecretString::from("test-key");
        let client = http_client(Duration::from_secs(30));
        check_key(&client, &server.uri(), &key, timeout).await
    }

    #[tokio::test]
    async fn check_key_probes_the_models_list_with_the_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(wiremock::matchers::query_param("limit", "1"))
            .and(header("x-api-key", "test-key"))
            .and(header("anthropic-version", ANTHROPIC_VERSION))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": []})))
            .expect(1)
            .mount(&server)
            .await;
        assert_eq!(check_with(&server, Duration::from_secs(5)).await, Ok(()));
    }

    #[tokio::test]
    async fn check_key_classifies_failures_without_reading_the_body() {
        for (status, expected) in [
            (401, KeyCheckError::Rejected),
            (403, KeyCheckError::Rejected),
            (429, KeyCheckError::Rejected),
            (500, KeyCheckError::Unreachable),
            (529, KeyCheckError::Unreachable),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(status).set_body_string("echo test-key"))
                .mount(&server)
                .await;
            let err = check_with(&server, Duration::from_secs(5))
                .await
                .unwrap_err();
            assert_eq!(err, expected, "{status}");
            assert!(!format!("{err:?}{err}").contains("test-key"));
        }
    }

    #[tokio::test]
    async fn check_key_times_out_as_unreachable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)))
            .mount(&server)
            .await;
        assert_eq!(
            check_with(&server, Duration::from_millis(100)).await,
            Err(KeyCheckError::Unreachable)
        );
    }

    #[test]
    fn debug_never_shows_the_key() {
        let p = ClaudeProvider::new(SecretString::from("sk-very-secret"), "m");
        assert!(!format!("{p:?}").contains("sk-very-secret"));
    }

    mod streaming {
        use super::*;
        use std::sync::Mutex;

        fn sse(events: &[(&str, Value)]) -> String {
            events
                .iter()
                .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
                .collect()
        }

        fn tool_events(fragments: &[&str]) -> Vec<(&'static str, Value)> {
            let mut events = vec![
                ("message_start", json!({"type": "message_start"})),
                (
                    "content_block_start",
                    json!({"type": "content_block_start", "index": 0,
                        "content_block": {"type": "text", "text": ""}}),
                ),
                (
                    "content_block_delta",
                    json!({"type": "content_block_delta", "index": 0,
                        "delta": {"type": "text_delta", "text": "thinking"}}),
                ),
                ("ping", json!({"type": "ping"})),
                (
                    "content_block_start",
                    json!({"type": "content_block_start", "index": 1,
                        "content_block": {"type": "tool_use", "id": "t", "name": "emit_pattern", "input": {}}}),
                ),
            ];
            for fragment in fragments {
                events.push((
                    "content_block_delta",
                    json!({"type": "content_block_delta", "index": 1,
                        "delta": {"type": "input_json_delta", "partial_json": fragment}}),
                ));
            }
            events.push((
                "content_block_stop",
                json!({"type": "content_block_stop", "index": 1}),
            ));
            events.push(("message_stop", json!({"type": "message_stop"})));
            events
        }

        fn stream_response(body: String) -> ResponseTemplate {
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(body)
        }

        async fn run(response: ResponseTemplate) -> (Result<Value, ProviderError>, Vec<String>) {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/v1/messages"))
                .respond_with(response)
                .mount(&server)
                .await;
            let seen = Mutex::new(Vec::new());
            let push = |fragment: &str| seen.lock().unwrap().push(fragment.to_string());
            let result = provider(&server)
                .generate_streaming(&request(), &TextSink::new(&push))
                .await;
            (result, seen.into_inner().unwrap())
        }

        #[tokio::test]
        async fn fragments_reach_the_sink_in_order_and_the_value_matches_the_buffered_result() {
            let fragments = ["{\"na", "me\":\"o", "k\"}"];
            let (result, seen) = run(stream_response(sse(&tool_events(&fragments)))).await;
            assert_eq!(seen, fragments);
            assert_eq!(result.unwrap(), json!({"name": "ok"}));

            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "content": [{"type": "tool_use", "name": "emit_pattern", "input": {"name": "ok"}}]
                })))
                .mount(&server)
                .await;
            let buffered = provider(&server).generate(&request()).await.unwrap();
            assert_eq!(buffered, json!({"name": "ok"}));
        }

        #[tokio::test]
        async fn the_request_asks_for_a_stream() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(stream_response(sse(&tool_events(&["{}"]))))
                .mount(&server)
                .await;
            provider(&server)
                .generate_streaming(&request(), &TextSink::discard())
                .await
                .unwrap();
            let sent: Value = server.received_requests().await.unwrap()[0]
                .body_json()
                .unwrap();
            assert_eq!(sent["stream"], true);
            assert_eq!(
                sent["tool_choice"],
                json!({"type": "tool", "name": "emit_pattern"})
            );
        }

        #[tokio::test]
        async fn text_blocks_are_not_forwarded() {
            let (_, seen) = run(stream_response(sse(&tool_events(&["{}"])))).await;
            assert_eq!(seen, ["{}"]);
        }

        #[tokio::test]
        async fn http_errors_map_as_they_do_without_streaming() {
            let cases = [
                (
                    401,
                    anthropic_error("authentication_error"),
                    None,
                    ProviderError::Unauthorized,
                ),
                (
                    429,
                    anthropic_error("rate_limit_error"),
                    Some("20"),
                    ProviderError::RateLimited {
                        retry_after: Some(20),
                    },
                ),
            ];
            for (status, body, retry_after, expected) in cases {
                let mut response = ResponseTemplate::new(status).set_body_json(body);
                if let Some(value) = retry_after {
                    response = response.insert_header("retry-after", value);
                }
                let (result, seen) = run(response).await;
                assert_eq!(result.unwrap_err(), expected);
                assert!(seen.is_empty());
            }
            let (result, _) =
                run(ResponseTemplate::new(529).set_body_string("secret upstream detail")).await;
            let err = result.unwrap_err();
            assert!(matches!(err, ProviderError::Request(_)));
            assert!(err.to_string().contains("529"));
            assert!(!err.to_string().contains("secret upstream detail"));
        }

        #[tokio::test]
        async fn a_mid_stream_error_maps_like_the_matching_status_without_the_body() {
            for (kind, expected) in [
                ("authentication_error", ProviderError::Unauthorized),
                (
                    "rate_limit_error",
                    ProviderError::RateLimited { retry_after: None },
                ),
                ("billing_error", ProviderError::QuotaExhausted),
            ] {
                let mut events = tool_events(&["{\"na"]);
                events.truncate(6);
                events.push(("error", anthropic_error_event(kind)));
                let (result, seen) = run(stream_response(sse(&events))).await;
                assert_eq!(result.unwrap_err(), expected, "{kind}");
                assert_eq!(seen, ["{\"na"]);
            }
            let mut events = tool_events(&[]);
            events.truncate(5);
            events.push(("error", anthropic_error_event("overloaded_error")));
            let (result, _) = run(stream_response(sse(&events))).await;
            let err = result.unwrap_err();
            assert!(matches!(err, ProviderError::Request(_)), "{err}");
            assert!(!err.to_string().contains("SECRET-BODY-TEXT"));
        }

        fn anthropic_error_event(kind: &str) -> Value {
            json!({"type": "error", "error": {"type": kind, "message": "SECRET-BODY-TEXT"}})
        }

        #[tokio::test]
        async fn a_stream_that_ends_early_is_a_request_error() {
            let mut events = tool_events(&["{\"na"]);
            events.pop();
            let (result, _) = run(stream_response(sse(&events))).await;
            assert!(matches!(result.unwrap_err(), ProviderError::Request(_)));
        }

        #[tokio::test]
        async fn a_stream_without_the_tool_call_is_invalid_output() {
            let events = vec![
                ("message_start", json!({"type": "message_start"})),
                ("message_stop", json!({"type": "message_stop"})),
            ];
            let (result, _) = run(stream_response(sse(&events))).await;
            assert!(matches!(
                result.unwrap_err(),
                ProviderError::InvalidOutput(_)
            ));
        }

        #[tokio::test]
        async fn incomplete_tool_json_is_invalid_output() {
            let (result, _) = run(stream_response(sse(&tool_events(&["{\"na"])))).await;
            assert!(matches!(
                result.unwrap_err(),
                ProviderError::InvalidOutput(_)
            ));
        }

        #[tokio::test]
        async fn an_oversize_stream_is_rejected() {
            let padding = "x".repeat(5 * 1024 * 1024);
            let events = tool_events(&[padding.as_str()]);
            let (result, _) = run(stream_response(sse(&events))).await;
            assert!(
                matches!(result.unwrap_err(), ProviderError::Request(m) if m.contains("limit"))
            );
        }
    }
}
