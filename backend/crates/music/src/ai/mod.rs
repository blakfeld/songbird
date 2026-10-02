//! Transports are generic over the output schema so every instrument can reuse
//! them: an instrument supplies its own prompt and schema and parses the JSON.

pub mod claude;
pub mod codex;
pub mod mock;
pub mod ollama;
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
pub use mock::MockProvider;
pub use ollama::OllamaProvider;
pub use plan::{MockPlanProvider, PlanProvider, SchemaPlanProvider};

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
}

/// Fails fast when the host is down instead of consuming the whole request budget.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Backstop for callers that do not set their own; the API passes its configured generation timeout.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Structured outputs are a few KiB; a larger body means a misbehaving or hostile endpoint,
/// and buffering it unbounded would let one response exhaust memory.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
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
        .map_err(|e| ProviderError::Request(format!("could not read the response: {e}")))?
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
