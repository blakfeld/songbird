//! Users' own AI provider keys: the types that carry them, how they are sealed at rest,
//! and where they are stored.

mod crypto;
mod dto;
mod maintenance;
mod store;

use std::fmt;
use std::str::FromStr;

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use crypto::{decrypt, encrypt, CryptoError, EncryptedKey};
pub use dto::{AiKeyEntry, AiKeySummary, SetProviderBody};
pub use maintenance::{
    count_not_on_version, count_with_version, purge_version, rotate, rotate_with_hook,
    RotationReport,
};
pub use store::{
    active_key, delete, key_versions_in_use, set_active, summary, upsert, KeyInfo, KeyStoreError,
    KeySummary, StoredKey,
};

const LAST_CHARS_SHOWN: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Anthropic,
    Openai,
}

impl AiProvider {
    pub const ALL: [AiProvider; 2] = [Self::Anthropic, Self::Openai];

    /// Also the value stored in the `provider` columns and bound into the encryption AAD.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
        }
    }

    /// For messages shown to users, who know the vendors by their brand spelling.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Anthropic => "Anthropic",
            Self::Openai => "OpenAI",
        }
    }
}

impl FromStr for AiProvider {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL.into_iter().find(|p| p.as_str() == s).ok_or(())
    }
}

/// Deliberately not `Clone`, `Display` or `Serialize`, so a copy or a log line of the
/// plaintext has to be written out on purpose.
pub struct UserApiKey(SecretString);

impl UserApiKey {
    pub fn new(key: impl Into<SecretString>) -> Self {
        Self(key.into())
    }

    /// Only transports building an auth header and `encrypt` should call this.
    pub fn expose_secret(&self) -> &str {
        self.0.expose_secret()
    }

    /// Stored in clear so the summary can identify a key without decrypting it.
    pub fn last4(&self) -> String {
        let chars: Vec<char> = self.expose_secret().chars().collect();
        chars[chars.len().saturating_sub(LAST_CHARS_SHOWN)..]
            .iter()
            .collect()
    }
}

impl fmt::Debug for UserApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("UserApiKey(<redacted>)")
    }
}
