//! Transports are generic over the output schema so every instrument can reuse
//! them: an instrument supplies its own prompt and schema and parses the JSON.

pub mod claude;
pub mod codex;
pub mod mock;
pub mod ollama;
pub mod prompt;

use async_trait::async_trait;
use serde_json::Value;

use crate::draft::PatternDraft;
use crate::instruments::Instrument;
use crate::request::GenerateRequest;

pub use claude::ClaudeProvider;
pub use codex::CodexCliProvider;
pub use mock::MockProvider;
pub use ollama::OllamaProvider;

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

#[async_trait]
pub trait StructuredProvider: Send + Sync {
    fn name(&self) -> &'static str;

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError>;

    /// Run at startup so a misconfigured provider fails fast instead of on the
    /// first user request.
    async fn check(&self) -> Result<(), ProviderError>;
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
            system: prompt::system_prompt(instrument),
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
