use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{AiProvider, KeySummary};

/// Carries no key material by construction, so the summary is safe to return and cache-bust
/// without a separate redaction step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct AiKeyEntry {
    pub provider: AiProvider,
    pub last4: String,
    /// Milliseconds like the projects API, so the browser formats every timestamp one way.
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct AiKeySummary {
    pub keys_required: bool,
    pub active_provider: Option<AiProvider>,
    pub keys: Vec<AiKeyEntry>,
}

impl AiKeySummary {
    pub fn new(keys_required: bool, stored: KeySummary) -> Self {
        Self {
            keys_required,
            active_provider: stored.active_provider,
            keys: stored
                .keys
                .into_iter()
                .map(|k| AiKeyEntry {
                    provider: k.provider,
                    last4: k.last4,
                    updated_at: k.updated_at,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SetProviderBody {
    pub provider: AiProvider,
}
