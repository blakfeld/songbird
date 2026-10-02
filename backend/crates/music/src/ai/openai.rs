use async_trait::async_trait;
use reqwest::Client;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};
use std::time::Duration;

use std::ops::ControlFlow;

use super::sse::SseParser;
use super::{
    http_client, probe_models, read_error_fields, read_json_capped, read_stream_capped,
    retry_after_secs, transport_error, ErrorFields, KeyCheckError, ProviderError,
    StructuredProvider, StructuredRequest, TextSink, DEFAULT_REQUEST_TIMEOUT,
};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com";
/// Matches Claude's bound so the two vendors cost about the same per generation.
pub const DEFAULT_MAX_TOKENS: u32 = 4096;

/// OpenAI reports a spent budget as a 429, so only these markers tell it apart from a
/// transient rate limit that is worth retrying later.
const QUOTA_MARKERS: [&str; 5] = [
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
];

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
            .get(format!("{}/v1/models", base_url.trim_end_matches('/')))
            .bearer_auth(api_key.expose_secret()),
        timeout,
    )
    .await
}

/// 403 is left generic because OpenAI uses it for unsupported regions, which a user cannot
/// fix by replacing their key.
fn classify_error(
    status: u16,
    fields: &ErrorFields,
    retry_after: Option<u64>,
) -> Option<ProviderError> {
    match status {
        401 => Some(ProviderError::Unauthorized),
        429 if fields.is_any_of(&QUOTA_MARKERS) => Some(ProviderError::QuotaExhausted),
        429 => Some(ProviderError::RateLimited { retry_after }),
        _ => None,
    }
}

pub struct OpenAiProvider {
    client: Client,
    base_url: String,
    api_key: SecretString,
    model: String,
    max_tokens: u32,
}

impl OpenAiProvider {
    pub fn new(api_key: SecretString, model: impl Into<String>) -> Self {
        Self {
            client: http_client(DEFAULT_REQUEST_TIMEOUT),
            base_url: DEFAULT_BASE_URL.into(),
            api_key,
            model: model.into(),
            max_tokens: DEFAULT_MAX_TOKENS,
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

impl OpenAiProvider {
    /// Shared by both paths so status handling cannot drift between them.
    async fn send(
        &self,
        request: &StructuredRequest,
        stream: bool,
    ) -> Result<reqwest::Response, ProviderError> {
        // Strict json_schema is what makes the model return schema-shaped JSON.
        let mut body = json!({
            "model": self.model,
            "max_completion_tokens": self.max_tokens,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": request.tool_name,
                    "description": request.tool_description,
                    "schema": request.schema,
                    "strict": true,
                },
            },
        });
        if stream {
            body["stream"] = json!(true);
        }
        let response = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .bearer_auth(self.api_key.expose_secret())
            .json(&body)
            .send()
            .await
            .map_err(|e| transport_error("OpenAI", &e))?;

        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let retry_after = retry_after_secs(response.headers());
        let fields = read_error_fields(response).await;
        // The body text is dropped: it may echo request content.
        Err(
            classify_error(status.as_u16(), &fields, retry_after).unwrap_or_else(|| {
                ProviderError::Request(format!("the OpenAI API returned HTTP {status}"))
            }),
        )
    }
}

/// The same early-end checks as the buffered path, applied as chunks arrive so a refusal or
/// truncation fails without waiting for the rest of the stream.
#[derive(Default)]
struct CompletionStream {
    content: String,
    finished: bool,
}

impl CompletionStream {
    fn handle(
        &mut self,
        data: &str,
        text: &TextSink<'_>,
    ) -> Result<ControlFlow<()>, ProviderError> {
        if data.trim() == "[DONE]" {
            self.finished = true;
            return Ok(ControlFlow::Break(()));
        }
        let chunk: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::InvalidOutput("stream event is not JSON".into()))?;
        if chunk.get("error").is_some() {
            return Err(stream_error(&chunk["error"]));
        }
        let choice = &chunk["choices"][0];
        let delta = &choice["delta"];
        if delta["refusal"].as_str().is_some_and(|r| !r.is_empty()) {
            return Err(ProviderError::InvalidOutput("the model refused".into()));
        }
        if let Some(fragment) = delta["content"].as_str().filter(|c| !c.is_empty()) {
            self.content.push_str(fragment);
            text.emit(fragment);
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            if matches!(reason, "length" | "content_filter") {
                return Err(ProviderError::InvalidOutput(format!(
                    "generation ended early ({reason})"
                )));
            }
            self.finished = true;
        }
        Ok(ControlFlow::Continue(()))
    }

    fn finish(self) -> Result<Value, ProviderError> {
        if !self.finished {
            return Err(ProviderError::Request(
                "the OpenAI stream ended before the response finished".into(),
            ));
        }
        if self.content.trim().is_empty() {
            return Err(ProviderError::InvalidOutput(
                "response had no content".into(),
            ));
        }
        serde_json::from_str(&self.content)
            .map_err(|e| ProviderError::InvalidOutput(format!("content is not JSON: {e}")))
    }
}

/// Only the machine-readable fields are read, as for HTTP errors, because the status line was
/// already sent as 200 and the message text can echo request content.
fn stream_error(error: &Value) -> ProviderError {
    let fields: ErrorFields = serde_json::from_value(error.clone()).unwrap_or_default();
    if fields.is_any_of(&QUOTA_MARKERS) {
        ProviderError::QuotaExhausted
    } else if fields.is_any_of(&["rate_limit_exceeded"]) {
        ProviderError::RateLimited { retry_after: None }
    } else if fields.is_any_of(&["invalid_api_key"]) {
        ProviderError::Unauthorized
    } else {
        ProviderError::Request("the OpenAI API reported an error during the response".into())
    }
}

impl std::fmt::Debug for OpenAiProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiProvider")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl StructuredProvider for OpenAiProvider {
    fn name(&self) -> &'static str {
        "openai"
    }

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError> {
        let response = self.send(request, false).await?;
        let payload = read_json_capped(response).await?;
        let choice = &payload["choices"][0];
        let message = &choice["message"];
        if message["refusal"].as_str().is_some_and(|r| !r.is_empty()) {
            return Err(ProviderError::InvalidOutput("the model refused".into()));
        }
        // Truncated or filtered output may still parse as JSON that is silently incomplete.
        if let Some(reason @ ("length" | "content_filter")) = choice["finish_reason"].as_str() {
            return Err(ProviderError::InvalidOutput(format!(
                "generation ended early ({reason})"
            )));
        }
        let content = message["content"]
            .as_str()
            .filter(|c| !c.trim().is_empty())
            .ok_or_else(|| ProviderError::InvalidOutput("response had no content".into()))?;
        serde_json::from_str(content)
            .map_err(|e| ProviderError::InvalidOutput(format!("content is not JSON: {e}")))
    }

    async fn generate_streaming(
        &self,
        request: &StructuredRequest,
        text: &TextSink<'_>,
    ) -> Result<Value, ProviderError> {
        let response = self.send(request, true).await?;
        let mut parser = SseParser::new();
        let mut stream = CompletionStream::default();
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
        // Keys arrive per user and are validated when saved, so there is nothing to probe at startup.
        if self.api_key.expose_secret().trim().is_empty() {
            return Err(ProviderError::Unavailable(
                "an OpenAI API key is required".into(),
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

    fn provider(server: &MockServer) -> OpenAiProvider {
        OpenAiProvider::new(SecretString::from("test-key"), "gpt-test")
            .with_base_url(server.uri())
            .with_max_tokens(1234)
    }

    fn completion(message: Value, finish_reason: &str) -> Value {
        json!({"choices": [{"message": message, "finish_reason": finish_reason}]})
    }

    async fn generate_with(response: ResponseTemplate) -> Result<Value, ProviderError> {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(response)
            .mount(&server)
            .await;
        provider(&server).generate(&request()).await
    }

    #[tokio::test]
    async fn sends_a_strict_json_schema_request_and_parses_the_content() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(completion(
                json!({"role": "assistant", "content": "{\"name\":\"ok\"}", "refusal": null}),
                "stop",
            )))
            .expect(1)
            .mount(&server)
            .await;

        let value = provider(&server).generate(&request()).await.unwrap();
        assert_eq!(value, json!({"name": "ok"}));

        let sent: Value = server.received_requests().await.unwrap()[0]
            .body_json()
            .unwrap();
        assert_eq!(sent["model"], "gpt-test");
        assert_eq!(sent["max_completion_tokens"], 1234);
        assert_eq!(
            sent["messages"],
            json!([
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "usr"},
            ])
        );
        assert_eq!(
            sent["response_format"],
            json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "emit_pattern",
                    "description": "d",
                    "schema": {"type": "object"},
                    "strict": true,
                },
            })
        );
    }

    #[tokio::test]
    async fn refusal_is_invalid_output_without_its_text() {
        let err = generate_with(ResponseTemplate::new(200).set_body_json(completion(
            json!({"content": null, "refusal": "SECRET-REFUSAL"}),
            "stop",
        )))
        .await
        .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidOutput(_)));
        assert!(!err.to_string().contains("SECRET-REFUSAL"));
    }

    #[tokio::test]
    async fn truncated_or_filtered_output_is_invalid_output() {
        for reason in ["length", "content_filter"] {
            let err = generate_with(
                ResponseTemplate::new(200)
                    .set_body_json(completion(json!({"content": "{\"name\":\"cut"}), reason)),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, ProviderError::InvalidOutput(m) if m.contains(reason)));
        }
    }

    #[tokio::test]
    async fn empty_missing_or_non_json_content_is_invalid_output() {
        for message in [
            json!({"content": ""}),
            json!({"content": null}),
            json!({}),
            json!({"content": "not json"}),
        ] {
            let err = generate_with(
                ResponseTemplate::new(200).set_body_json(completion(message, "stop")),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, ProviderError::InvalidOutput(_)));
        }
        let err = generate_with(ResponseTemplate::new(200).set_body_string("<html>"))
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidOutput(_)));
    }

    #[tokio::test]
    async fn oversize_response_is_rejected() {
        let err =
            generate_with(ResponseTemplate::new(200).set_body_bytes(vec![b' '; 5 * 1024 * 1024]))
                .await
                .unwrap_err();
        assert!(matches!(err, ProviderError::Request(m) if m.contains("limit")));
    }

    fn openai_error(kind: &str, code: Option<&str>) -> Value {
        json!({"error": {"message": "SECRET-BODY-TEXT", "type": kind, "param": null, "code": code}})
    }

    async fn error_from(status: u16, body: Value, retry_after: Option<&str>) -> ProviderError {
        let mut response = ResponseTemplate::new(status).set_body_json(body);
        if let Some(value) = retry_after {
            response = response.insert_header("retry-after", value);
        }
        let err = generate_with(response).await.unwrap_err();
        assert!(!err.to_string().contains("SECRET-BODY-TEXT"));
        err
    }

    #[tokio::test]
    async fn unauthorized_is_classified_from_the_status() {
        let err = error_from(
            401,
            openai_error("invalid_request_error", Some("invalid_api_key")),
            None,
        )
        .await;
        assert_eq!(err, ProviderError::Unauthorized);
    }

    #[tokio::test]
    async fn spent_budget_429s_are_quota_exhausted_by_code_or_type() {
        for body in [
            openai_error("insufficient_quota", Some("insufficient_quota")),
            openai_error("x", Some("credit_balance_exhausted")),
            openai_error("organization_spend_limit_exceeded", None),
            openai_error("x", Some("project_spend_limit_exceeded")),
            openai_error("organization_usage_limit_exceeded", None),
        ] {
            assert_eq!(
                error_from(429, body, Some("5")).await,
                ProviderError::QuotaExhausted
            );
        }
    }

    #[tokio::test]
    async fn other_429s_are_rate_limited_with_a_capped_optional_retry_after() {
        let body = || openai_error("requests", Some("rate_limit_exceeded"));
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
            error_from(429, body(), Some("86400")).await,
            ProviderError::RateLimited {
                retry_after: Some(3600)
            }
        );
    }

    #[tokio::test]
    async fn forbidden_and_server_errors_stay_generic() {
        for status in [403, 500, 503] {
            let err = error_from(status, openai_error("x", None), None).await;
            assert!(matches!(err, ProviderError::Request(_)), "{status}: {err}");
            assert!(err.to_string().contains(&status.to_string()));
        }
    }

    async fn check_with(server: &MockServer, timeout: Duration) -> Result<(), KeyCheckError> {
        let key = SecretString::from("test-key");
        let client = http_client(Duration::from_secs(30));
        check_key(&client, &server.uri(), &key, timeout).await
    }

    #[tokio::test]
    async fn check_key_probes_the_models_list_with_the_bearer_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(header("authorization", "Bearer test-key"))
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
            (503, KeyCheckError::Unreachable),
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
        let p = OpenAiProvider::new(SecretString::from("sk-very-secret"), "m");
        assert!(!format!("{p:?}").contains("sk-very-secret"));
    }

    mod streaming {
        use super::*;
        use std::sync::Mutex;

        fn chunk(delta: Value, finish_reason: Value) -> String {
            let data = json!({"choices": [{"delta": delta, "finish_reason": finish_reason}]});
            format!("data: {data}\n\n")
        }

        fn content_stream(fragments: &[&str], finish_reason: &str) -> String {
            let mut body = chunk(json!({"role": "assistant", "content": ""}), Value::Null);
            for fragment in fragments {
                body += &chunk(json!({"content": fragment}), Value::Null);
            }
            body += &chunk(json!({}), json!(finish_reason));
            body + "data: [DONE]\n\n"
        }

        fn stream_response(body: String) -> ResponseTemplate {
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(body)
        }

        async fn run(response: ResponseTemplate) -> (Result<Value, ProviderError>, Vec<String>) {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/v1/chat/completions"))
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
            let (result, seen) = run(stream_response(content_stream(&fragments, "stop"))).await;
            assert_eq!(seen, fragments);
            let streamed = result.unwrap();

            let buffered = generate_with(ResponseTemplate::new(200).set_body_json(completion(
                json!({"role": "assistant", "content": "{\"name\":\"ok\"}"}),
                "stop",
            )))
            .await
            .unwrap();
            assert_eq!(streamed, buffered);
        }

        #[tokio::test]
        async fn the_request_asks_for_a_stream_with_the_strict_schema() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(header("authorization", "Bearer test-key"))
                .respond_with(stream_response(content_stream(&["{}"], "stop")))
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
            assert_eq!(sent["response_format"]["json_schema"]["strict"], true);
        }

        #[tokio::test]
        async fn http_errors_map_as_they_do_without_streaming() {
            let quota =
                json!({"error": {"type": "insufficient_quota", "message": "SECRET-BODY-TEXT"}});
            let cases = [
                (
                    401,
                    json!({"error": {"type": "invalid_request_error"}}),
                    None,
                    ProviderError::Unauthorized,
                ),
                (
                    429,
                    json!({"error": {"type": "requests"}}),
                    Some("20"),
                    ProviderError::RateLimited {
                        retry_after: Some(20),
                    },
                ),
                (429, quota, None, ProviderError::QuotaExhausted),
            ];
            for (status, body, retry_after, expected) in cases {
                let mut response = ResponseTemplate::new(status).set_body_json(body);
                if let Some(value) = retry_after {
                    response = response.insert_header("retry-after", value);
                }
                let (result, seen) = run(response).await;
                let err = result.unwrap_err();
                assert_eq!(err, expected);
                assert!(!err.to_string().contains("SECRET-BODY-TEXT"));
                assert!(seen.is_empty());
            }
            let (result, _) =
                run(ResponseTemplate::new(503).set_body_string("secret upstream detail")).await;
            let err = result.unwrap_err();
            assert!(matches!(err, ProviderError::Request(_)));
            assert!(err.to_string().contains("503"));
            assert!(!err.to_string().contains("secret upstream detail"));
        }

        #[tokio::test]
        async fn a_mid_stream_error_maps_without_the_body() {
            for (code, expected) in [
                ("insufficient_quota", Some(ProviderError::QuotaExhausted)),
                (
                    "rate_limit_exceeded",
                    Some(ProviderError::RateLimited { retry_after: None }),
                ),
                ("invalid_api_key", Some(ProviderError::Unauthorized)),
                ("server_error", None),
            ] {
                let mut body = chunk(json!({"content": "{\"na"}), Value::Null);
                let error = json!({"error": {"code": code, "message": "SECRET-BODY-TEXT"}});
                body += &format!("data: {error}\n\n");
                let (result, seen) = run(stream_response(body)).await;
                let err = result.unwrap_err();
                match expected {
                    Some(expected) => assert_eq!(err, expected, "{code}"),
                    None => assert!(matches!(err, ProviderError::Request(_)), "{err}"),
                }
                assert!(!err.to_string().contains("SECRET-BODY-TEXT"));
                assert_eq!(seen, ["{\"na"]);
            }
        }

        #[tokio::test]
        async fn truncation_filtering_and_refusals_are_invalid_output() {
            for reason in ["length", "content_filter"] {
                let (result, _) = run(stream_response(content_stream(&["{}"], reason))).await;
                let err = result.unwrap_err();
                assert!(
                    matches!(&err, ProviderError::InvalidOutput(m) if m.contains(reason)),
                    "{err}"
                );
            }
            let refusal = chunk(json!({"refusal": "I cannot"}), Value::Null);
            let (result, _) = run(stream_response(refusal + "data: [DONE]\n\n")).await;
            assert!(matches!(
                result.unwrap_err(),
                ProviderError::InvalidOutput(_)
            ));
        }

        #[tokio::test]
        async fn empty_and_non_json_content_are_invalid_output() {
            let (result, _) = run(stream_response(content_stream(&[], "stop"))).await;
            assert!(matches!(
                result.unwrap_err(),
                ProviderError::InvalidOutput(_)
            ));
            let (result, _) = run(stream_response(content_stream(&["not json"], "stop"))).await;
            assert!(matches!(
                result.unwrap_err(),
                ProviderError::InvalidOutput(_)
            ));
        }

        #[tokio::test]
        async fn a_stream_that_ends_early_is_a_request_error() {
            let body = chunk(json!({"content": "{\"na"}), Value::Null);
            let (result, _) = run(stream_response(body)).await;
            assert!(matches!(result.unwrap_err(), ProviderError::Request(_)));
        }

        #[tokio::test]
        async fn an_oversize_stream_is_rejected() {
            let padding = "x".repeat(5 * 1024 * 1024);
            let (result, _) =
                run(stream_response(content_stream(&[padding.as_str()], "stop"))).await;
            assert!(
                matches!(result.unwrap_err(), ProviderError::Request(m) if m.contains("limit"))
            );
        }
    }
}
