use async_trait::async_trait;
use reqwest::Client;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};
use std::time::Duration;

use super::{
    http_client, probe_models, read_error_fields, read_json_capped, retry_after_secs,
    transport_error, ErrorFields, KeyCheckError, ProviderError, StructuredProvider,
    StructuredRequest, DEFAULT_REQUEST_TIMEOUT,
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
}

impl ClaudeProvider {
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
        // Forcing the tool call is what makes the model return schema-shaped JSON.
        let body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": request.system,
            "messages": [{"role": "user", "content": request.user}],
            "tools": [{
                "name": request.tool_name,
                "description": request.tool_description,
                "input_schema": request.schema,
            }],
            "tool_choice": {"type": "tool", "name": request.tool_name},
        });
        let response = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", self.api_key.expose_secret())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| transport_error("Anthropic", &e))?;

        let status = response.status();
        if !status.is_success() {
            let retry_after = retry_after_secs(response.headers());
            let fields = read_error_fields(response).await;
            // The body text is dropped: it may echo request content.
            return Err(
                classify_error(status.as_u16(), &fields, retry_after).unwrap_or_else(|| {
                    ProviderError::Request(format!("the Anthropic API returned HTTP {status}"))
                }),
            );
        }
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
}
