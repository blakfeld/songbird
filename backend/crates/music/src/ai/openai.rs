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
        // Strict json_schema is what makes the model return schema-shaped JSON.
        let body = json!({
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
        let response = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .bearer_auth(self.api_key.expose_secret())
            .json(&body)
            .send()
            .await
            .map_err(|e| transport_error("OpenAI", &e))?;

        let status = response.status();
        if !status.is_success() {
            let retry_after = retry_after_secs(response.headers());
            let fields = read_error_fields(response).await;
            // The body text is dropped: it may echo request content.
            return Err(
                classify_error(status.as_u16(), &fields, retry_after).unwrap_or_else(|| {
                    ProviderError::Request(format!("the OpenAI API returned HTTP {status}"))
                }),
            );
        }
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
}
