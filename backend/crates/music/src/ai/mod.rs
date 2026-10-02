//! Transports are generic over the output schema so every instrument can reuse
//! them: an instrument supplies its own prompt and schema and parses the JSON.

pub mod claude;
pub mod codex;
pub mod lyrics;
pub mod mock;
pub mod ollama;
pub mod openai;
pub mod plan;
pub mod prompt;

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::draft::PatternDraft;
use crate::instruments::Instrument;
use crate::request::GenerateRequest;

pub use claude::ClaudeProvider;
pub use codex::CodexCliProvider;
pub use lyrics::{LyricsProvider, LyricsRequest, MockLyricsProvider, SchemaLyricsProvider};
pub use mock::MockProvider;
pub use ollama::OllamaProvider;
pub use openai::OpenAiProvider;
pub use plan::{MockPlanProvider, PlanProvider, SchemaPlanProvider};
/// Re-exported so callers can share one pooled client without depending on reqwest.
pub use reqwest::Client as HttpClient;

#[derive(Debug, Clone, PartialEq)]
pub struct StructuredRequest {
    pub system: String,
    pub user: String,
    pub schema: Value,
    /// Claude only returns schema-constrained JSON through a tool call, so the
    /// tool needs a name the system prompt can refer to.
    pub tool_name: String,
    pub tool_description: String,
}

/// Messages are logged, never sent to API clients, because they can contain
/// raw provider responses.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ProviderError {
    /// Carries a fix-it message because startup fails with it verbatim.
    #[error("{0}")]
    Unavailable(String),
    #[error("provider request failed: {0}")]
    Request(String),
    #[error("provider returned invalid output: {0}")]
    InvalidOutput(String),
    /// Fixed text only: these three come from classifying a vendor error and must not carry its body.
    #[error("the provider rejected the API key")]
    Unauthorized,
    #[error("the provider account has no remaining quota or credit")]
    QuotaExhausted,
    #[error("the provider rate limit was reached")]
    RateLimited { retry_after: Option<u64> },
}

/// Why a stored key could not be confirmed, kept coarse so callers can show a fixed message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KeyCheckError {
    #[error("the provider rejected the API key")]
    Rejected,
    #[error("the provider could not be reached")]
    Unreachable,
}

/// A hostile or buggy upstream could otherwise make the client tell users to wait for days.
const MAX_RETRY_AFTER_SECS: u64 = 3600;

pub(crate) fn retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|secs| secs.min(MAX_RETRY_AFTER_SECS))
}

/// Only the machine-readable fields are kept, because the message text can echo request content.
#[derive(Debug, Default, serde::Deserialize)]
pub(crate) struct ErrorFields {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub code: Option<String>,
}

impl ErrorFields {
    pub fn is_any_of(&self, names: &[&str]) -> bool {
        [&self.kind, &self.code]
            .into_iter()
            .flatten()
            .any(|v| names.contains(&v.as_str()))
    }
}

/// Both vendors nest the fields under `error`; anything unparseable yields no fields, so the
/// caller falls back to the status alone.
pub(crate) async fn read_error_fields(response: reqwest::Response) -> ErrorFields {
    #[derive(serde::Deserialize)]
    struct Envelope {
        error: Option<ErrorFields>,
    }
    read_json_capped(response)
        .await
        .ok()
        .and_then(|body| serde_json::from_value::<Envelope>(body).ok())
        .and_then(|e| e.error)
        .unwrap_or_default()
}

/// Shared by both vendors' `check_key`: the models list costs no tokens, and the body is never
/// read so an error that echoes the key cannot reach a log or a caller.
pub(crate) async fn probe_models(
    request: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<(), KeyCheckError> {
    let response = request
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| KeyCheckError::Unreachable)?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else if status.is_server_error() {
        Err(KeyCheckError::Unreachable)
    } else {
        Err(KeyCheckError::Rejected)
    }
}

/// Fails fast when the host is down instead of consuming the whole request budget.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Backstop for callers that do not set their own; the API passes its configured generation timeout.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Structured outputs are a few KiB; a larger body means a misbehaving or hostile endpoint,
/// and buffering it unbounded would let one response exhaust memory.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Fixed strings only: a reqwest error's text includes the URL and can carry connection
/// detail, and nothing from a request that bore a user's key should reach a log verbatim.
pub(crate) fn transport_error(vendor: &str, error: &reqwest::Error) -> ProviderError {
    let what = if error.is_timeout() {
        "timed out waiting for"
    } else if error.is_connect() {
        "could not connect to"
    } else {
        "could not complete the request to"
    };
    ProviderError::Request(format!("{what} the {vendor} API"))
}

pub fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        // reqwest drops only `Authorization` and `Cookie` on a cross-host redirect, so a redirect
        // from a provider endpoint would carry `x-api-key` to wherever it points; no provider
        // API legitimately redirects, so refusing every redirect is the safe policy.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
        .expect("static client configuration is valid")
}

pub(crate) async fn read_json_capped(response: reqwest::Response) -> Result<Value, ProviderError> {
    read_json_capped_at(response, MAX_RESPONSE_BYTES).await
}

async fn read_json_capped_at(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Value, ProviderError> {
    // Request rather than InvalidOutput because invalid output is retried, and a
    // hostile endpoint should not get a second read of the cap.
    let too_large = || ProviderError::Request(format!("response exceeds the {limit} byte limit"));
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProviderError::Request("could not read the response".into()))?
    {
        if body.len() + chunk.len() > limit {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|e| ProviderError::InvalidOutput(format!("response is not JSON: {e}")))
}

#[async_trait]
pub trait StructuredProvider: Send + Sync {
    fn name(&self) -> &'static str;

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError>;

    /// Run at startup so a misconfigured provider fails fast instead of on the
    /// first user request.
    async fn check(&self) -> Result<(), ProviderError>;
}

/// Lets one transport serve every provider kind, so startup checks and
/// connections are made once however many kinds are built over it.
#[async_trait]
impl<T: StructuredProvider + ?Sized> StructuredProvider for std::sync::Arc<T> {
    fn name(&self) -> &'static str {
        (**self).name()
    }

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError> {
        (**self).generate(request).await
    }

    async fn check(&self) -> Result<(), ProviderError> {
        (**self).check().await
    }
}

/// The seam between transports and the domain: providers only produce a draft,
/// so validation and normalization stay identical whichever one is selected.
#[async_trait]
pub trait PatternProvider: Send + Sync {
    async fn generate(
        &self,
        request: &GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError>;

    /// Run at startup so a misconfigured provider fails fast instead of on the
    /// first user request.
    async fn check(&self) -> Result<(), ProviderError>;
}

/// Every real provider shares one prompt and one schema through this adapter,
/// so switching providers changes quality and cost but never the contract.
pub struct SchemaProvider<T> {
    transport: T,
}

impl<T: StructuredProvider> SchemaProvider<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }
}

#[async_trait]
impl<T: StructuredProvider> PatternProvider for SchemaProvider<T> {
    async fn generate(
        &self,
        request: &GenerateRequest,
        instrument: &Instrument,
    ) -> Result<PatternDraft, ProviderError> {
        let structured = StructuredRequest {
            system: prompt::system_prompt_for(request, instrument),
            user: prompt::user_message(request),
            schema: prompt::draft_schema(instrument),
            tool_name: prompt::TOOL_NAME.into(),
            tool_description: prompt::TOOL_DESCRIPTION.into(),
        };
        let value = self.transport.generate(&structured).await?;
        PatternDraft::from_json(value).map_err(|e| ProviderError::InvalidOutput(e.to_string()))
    }

    async fn check(&self) -> Result<(), ProviderError> {
        self.transport.check().await
    }
}

#[cfg(test)]
mod capped_read_tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    // Chunked transfer sends no Content-Length, so only the streaming check can catch it.
    async fn chunked_response(payload: &'static str) -> reqwest::Response {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buf).await;
            let head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
            socket.write_all(head.as_bytes()).await.unwrap();
            for part in payload.as_bytes().chunks(8) {
                let frame = format!("{:x}\r\n{}\r\n", part.len(), String::from_utf8_lossy(part));
                socket.write_all(frame.as_bytes()).await.unwrap();
            }
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let response = reqwest::get(format!("http://{addr}")).await.unwrap();
        assert_eq!(response.content_length(), None);
        response
    }

    #[tokio::test]
    async fn streamed_body_over_the_limit_is_rejected() {
        let response = chunked_response(r#"{"padding":"xxxxxxxxxxxxxxxxxxxxxxxx"}"#).await;
        let err = read_json_capped_at(response, 16).await.unwrap_err();
        assert!(matches!(err, ProviderError::Request(m) if m.contains("limit")));
    }

    #[tokio::test]
    async fn streamed_body_within_the_limit_is_parsed() {
        let response = chunked_response(r#"{"ok":true}"#).await;
        let value = read_json_capped_at(response, 1024).await.unwrap();
        assert_eq!(value, serde_json::json!({"ok": true}));
    }
}

#[cfg(test)]
mod redirect_tests {
    use super::*;
    use secrecy::SecretString;
    use wiremock::matchers::any;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn redirecting_pair() -> (MockServer, MockServer) {
        let target = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&target)
            .await;
        let origin = MockServer::start().await;
        Mock::given(any())
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/stolen", target.uri()).as_str()),
            )
            .mount(&origin)
            .await;
        (origin, target)
    }

    fn request() -> StructuredRequest {
        StructuredRequest {
            system: "s".into(),
            user: "u".into(),
            schema: serde_json::json!({"type": "object"}),
            tool_name: "emit_pattern".into(),
            tool_description: "d".into(),
        }
    }

    #[tokio::test]
    async fn a_provider_redirect_is_not_followed_so_the_key_header_cannot_travel() {
        let key = SecretString::from("sk-redirect-secret-key-0000");
        for openai in [false, true] {
            let (origin, target) = redirecting_pair().await;
            let transport: Box<dyn StructuredProvider> = if openai {
                Box::new(OpenAiProvider::new(key.clone(), "m").with_base_url(origin.uri()))
            } else {
                Box::new(ClaudeProvider::new(key.clone(), "m").with_base_url(origin.uri()))
            };
            let error = transport.generate(&request()).await.unwrap_err();
            assert!(matches!(error, ProviderError::Request(_)), "{error}");
            assert!(error.to_string().contains("302"), "{error}");
            assert!(!error.to_string().contains("redirect-secret"));
            assert!(
                target.received_requests().await.unwrap().is_empty(),
                "the redirect target was contacted (openai: {openai})"
            );
        }
    }

    #[tokio::test]
    async fn a_key_check_redirect_is_rejected_without_contacting_the_target() {
        let (origin, target) = redirecting_pair().await;
        let key = SecretString::from("sk-redirect-secret-key-0000");
        let client = http_client(Duration::from_secs(5));
        let result = claude::check_key(&client, &origin.uri(), &key, Duration::from_secs(5)).await;
        assert_eq!(result, Err(KeyCheckError::Rejected));
        assert!(target.received_requests().await.unwrap().is_empty());
    }
}
