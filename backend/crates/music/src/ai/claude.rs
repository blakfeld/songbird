use async_trait::async_trait;
use reqwest::Client;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};

use super::{ProviderError, StructuredProvider, StructuredRequest};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// Pinned because the tool-use request shape is tied to an API version.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Bounds output cost: a compact draft for 32 measures fits well within this.
pub const DEFAULT_MAX_TOKENS: u32 = 4096;

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
            client: Client::new(),
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
            .map_err(|e| {
                ProviderError::Request(format!("could not reach the Anthropic API: {e}"))
            })?;

        let status = response.status();
        if !status.is_success() {
            // The body is dropped: it may echo request content.
            return Err(ProviderError::Request(format!(
                "the Anthropic API returned HTTP {status}"
            )));
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|e| ProviderError::InvalidOutput(format!("response is not JSON: {e}")))?;
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

    #[test]
    fn debug_never_shows_the_key() {
        let p = ClaudeProvider::new(SecretString::from("sk-very-secret"), "m");
        assert!(!format!("{p:?}").contains("sk-very-secret"));
    }
}
