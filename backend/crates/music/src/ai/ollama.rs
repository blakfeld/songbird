use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

use super::{
    http_client, read_json_capped, ProviderError, StructuredProvider, StructuredRequest,
    DEFAULT_REQUEST_TIMEOUT,
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

#[async_trait]
impl StructuredProvider for OllamaProvider {
    fn name(&self) -> &'static str {
        "ollama"
    }

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError> {
        // `format` makes Ollama constrain decoding to the schema, which keeps
        // small local models on-format.
        let body = json!({
            "model": self.model,
            "stream": false,
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
        let payload = read_json_capped(response).await?;
        let content = payload["message"]["content"].as_str().ok_or_else(|| {
            ProviderError::InvalidOutput("response had no message content".into())
        })?;
        serde_json::from_str(content)
            .map_err(|e| ProviderError::InvalidOutput(format!("message is not JSON: {e}")))
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
}
