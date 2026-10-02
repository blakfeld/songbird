//! Read once at startup and validated eagerly so a bad setting stops the
//! process with a message naming the variable instead of failing on a request.

use std::net::SocketAddr;
use std::str::FromStr;
use std::time::Duration;

use music::tokens::{
    DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_INPUT_TOKENS, MAX_MAX_CONTEXT_TOKENS,
    MAX_MAX_INPUT_TOKENS, MIN_MAX_INPUT_TOKENS,
};
use secrecy::SecretString;

use crate::db::DatabaseConfig;

pub const BIND_ADDR: &str = "SONGBIRD_BIND_ADDR";
pub const AI_PROVIDER: &str = "SONGBIRD_AI_PROVIDER";
pub const ANTHROPIC_API_KEY: &str = "ANTHROPIC_API_KEY";
pub const AI_MODEL: &str = "SONGBIRD_AI_MODEL";
pub const CORS_ORIGINS: &str = "SONGBIRD_CORS_ORIGINS";
pub const GENERATION_TIMEOUT_SECS: &str = "SONGBIRD_GENERATION_TIMEOUT_SECS";
pub const MAX_INPUT_TOKENS: &str = "SONGBIRD_MAX_INPUT_TOKENS";
pub const MAX_CONTEXT_TOKENS: &str = "SONGBIRD_MAX_CONTEXT_TOKENS";
pub const OLLAMA_URL: &str = "SONGBIRD_OLLAMA_URL";
pub const OLLAMA_MODEL: &str = "SONGBIRD_OLLAMA_MODEL";
pub const CODEX_BIN: &str = "SONGBIRD_CODEX_BIN";
pub const CODEX_MODEL: &str = "SONGBIRD_CODEX_MODEL";
pub const DATABASE_URL: &str = "SONGBIRD_DATABASE_URL";
pub const DATABASE_MAX_CONNECTIONS: &str = "SONGBIRD_DATABASE_MAX_CONNECTIONS";

/// A test keeps `.env.example` in sync with this list so operators can discover every setting.
pub const ALL_VARIABLES: [&str; 14] = [
    BIND_ADDR,
    AI_PROVIDER,
    ANTHROPIC_API_KEY,
    AI_MODEL,
    CORS_ORIGINS,
    GENERATION_TIMEOUT_SECS,
    MAX_INPUT_TOKENS,
    MAX_CONTEXT_TOKENS,
    OLLAMA_URL,
    OLLAMA_MODEL,
    CODEX_BIN,
    CODEX_MODEL,
    DATABASE_URL,
    DATABASE_MAX_CONNECTIONS,
];

const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8080";
const DEFAULT_CORS_ORIGIN: &str = "http://localhost:3000";
const DEFAULT_AI_MODEL: &str = "claude-sonnet-5-5";
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5:7b-instruct";
const DEFAULT_CODEX_BIN: &str = "codex";
const DEFAULT_DATABASE_MAX_CONNECTIONS: u32 = 10;
const MAX_DATABASE_MAX_CONNECTIONS: u32 = 100;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{var} is required when {reason}")]
    Missing {
        var: &'static str,
        reason: &'static str,
    },
    #[error("{var} is invalid: {problem}")]
    Invalid { var: &'static str, problem: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Claude,
    Ollama,
    Codex,
    Mock,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Ollama => "ollama",
            Self::Codex => "codex",
            Self::Mock => "mock",
        }
    }
}

impl FromStr for ProviderKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "claude" => Ok(Self::Claude),
            "ollama" => Ok(Self::Ollama),
            "codex" => Ok(Self::Codex),
            "mock" => Ok(Self::Mock),
            other => Err(format!(
                "\"{other}\" is not a provider; use claude, ollama, codex, or mock"
            )),
        }
    }
}

/// `Debug` is safe to log: the API key and database URL are `SecretString`s, which redact themselves.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub ai_provider: ProviderKind,
    pub anthropic_api_key: Option<SecretString>,
    pub ai_model: String,
    pub cors_origins: Vec<String>,
    pub generation_timeout: Duration,
    pub max_input_tokens: u32,
    pub max_context_tokens: u32,
    pub ollama_url: String,
    pub ollama_model: String,
    pub codex_bin: String,
    pub codex_model: Option<String>,
    pub database: DatabaseConfig,
}

impl Config {
    /// `.env` loading is the caller's job so tests never touch the real process
    /// environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|var| std::env::var(var).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // Blank counts as unset because `.env.example` ships empty placeholders.
        let get = |var: &str| {
            lookup(var)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let invalid = |var: &'static str, problem: String| ConfigError::Invalid { var, problem };

        let bind_addr = get(BIND_ADDR).unwrap_or_else(|| DEFAULT_BIND_ADDR.into());
        let bind_addr = bind_addr
            .parse::<SocketAddr>()
            .map_err(|e| invalid(BIND_ADDR, format!("\"{bind_addr}\" is not host:port ({e})")))?;

        let ai_provider = match get(AI_PROVIDER) {
            None => ProviderKind::Claude,
            Some(v) => v.parse().map_err(|p| invalid(AI_PROVIDER, p))?,
        };

        let anthropic_api_key = get(ANTHROPIC_API_KEY).map(SecretString::from);
        if ai_provider == ProviderKind::Claude && anthropic_api_key.is_none() {
            return Err(ConfigError::Missing {
                var: ANTHROPIC_API_KEY,
                reason: "SONGBIRD_AI_PROVIDER=claude",
            });
        }

        let cors_origins: Vec<String> = get(CORS_ORIGINS)
            .unwrap_or_else(|| DEFAULT_CORS_ORIGIN.into())
            .split(',')
            .map(|o| o.trim().trim_end_matches('/').to_string())
            .filter(|o| !o.is_empty())
            .collect();
        if let Some(bad) = cors_origins
            .iter()
            .find(|o| o.parse::<axum::http::HeaderValue>().is_err() || *o == "*")
        {
            return Err(invalid(
                CORS_ORIGINS,
                format!("\"{bad}\" is not a valid origin such as http://localhost:3000"),
            ));
        }

        let timeout_secs = match get(GENERATION_TIMEOUT_SECS) {
            None => DEFAULT_TIMEOUT_SECS,
            Some(v) => v.parse::<u64>().ok().filter(|s| *s > 0).ok_or_else(|| {
                invalid(
                    GENERATION_TIMEOUT_SECS,
                    format!("\"{v}\" is not a positive number of seconds"),
                )
            })?,
        };

        let max_input_tokens = match get(MAX_INPUT_TOKENS) {
            None => DEFAULT_MAX_INPUT_TOKENS,
            Some(v) => v
                .parse::<u32>()
                .ok()
                .filter(|t| (MIN_MAX_INPUT_TOKENS..=MAX_MAX_INPUT_TOKENS).contains(t))
                .ok_or_else(|| {
                    invalid(
                        MAX_INPUT_TOKENS,
                        format!(
                            "\"{v}\" is not an integer between {MIN_MAX_INPUT_TOKENS} and {MAX_MAX_INPUT_TOKENS}"
                        ),
                    )
                })?,
        };

        let max_context_tokens = match get(MAX_CONTEXT_TOKENS) {
            None => DEFAULT_MAX_CONTEXT_TOKENS,
            Some(v) => v
                .parse::<u32>()
                .ok()
                .filter(|t| *t <= MAX_MAX_CONTEXT_TOKENS)
                .ok_or_else(|| {
                    invalid(
                        MAX_CONTEXT_TOKENS,
                        format!("\"{v}\" is not an integer between 0 and {MAX_MAX_CONTEXT_TOKENS}"),
                    )
                })?,
        };

        let database_max_connections = match get(DATABASE_MAX_CONNECTIONS) {
            None => DEFAULT_DATABASE_MAX_CONNECTIONS,
            Some(v) => v
                .parse::<u32>()
                .ok()
                .filter(|n| (1..=MAX_DATABASE_MAX_CONNECTIONS).contains(n))
                .ok_or_else(|| {
                    invalid(
                        DATABASE_MAX_CONNECTIONS,
                        format!(
                            "\"{v}\" is not an integer between 1 and {MAX_DATABASE_MAX_CONNECTIONS}"
                        ),
                    )
                })?,
        };

        Ok(Self {
            bind_addr,
            ai_provider,
            anthropic_api_key,
            ai_model: get(AI_MODEL).unwrap_or_else(|| DEFAULT_AI_MODEL.into()),
            cors_origins,
            generation_timeout: Duration::from_secs(timeout_secs),
            max_input_tokens,
            max_context_tokens,
            ollama_url: get(OLLAMA_URL)
                .unwrap_or_else(|| DEFAULT_OLLAMA_URL.into())
                .trim_end_matches('/')
                .to_string(),
            ollama_model: get(OLLAMA_MODEL).unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.into()),
            codex_bin: get(CODEX_BIN).unwrap_or_else(|| DEFAULT_CODEX_BIN.into()),
            codex_model: get(CODEX_MODEL),
            database: DatabaseConfig {
                url: get(DATABASE_URL).map(SecretString::from),
                max_connections: database_max_connections,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn mock(extra: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let mut pairs = vec![(AI_PROVIDER, "mock")];
        pairs.extend_from_slice(extra);
        Config::from_lookup(lookup(&pairs))
    }

    #[test]
    fn defaults_apply() {
        let c = mock(&[]).unwrap();
        assert_eq!(c.bind_addr, "127.0.0.1:8080".parse().unwrap());
        assert_eq!(c.max_input_tokens, 256);
        assert_eq!(c.generation_timeout, Duration::from_secs(60));
        assert_eq!(c.cors_origins, ["http://localhost:3000"]);
        assert_eq!(c.ollama_url, "http://localhost:11434");
        assert_eq!(c.codex_bin, "codex");
        assert_eq!(c.codex_model, None);
    }

    #[test]
    fn provider_defaults_to_claude_and_needs_a_key() {
        let err = Config::from_lookup(lookup(&[])).unwrap_err();
        assert_eq!(
            err,
            ConfigError::Missing {
                var: ANTHROPIC_API_KEY,
                reason: "SONGBIRD_AI_PROVIDER=claude"
            }
        );
        assert!(err.to_string().contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn blank_key_counts_as_missing() {
        let err = Config::from_lookup(lookup(&[
            (AI_PROVIDER, "claude"),
            (ANTHROPIC_API_KEY, "  "),
        ]))
        .unwrap_err();
        assert!(err.to_string().contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn unknown_provider_names_the_variable() {
        let err = Config::from_lookup(lookup(&[(AI_PROVIDER, "gpt")])).unwrap_err();
        assert!(err.to_string().contains(AI_PROVIDER));
    }

    #[test]
    fn max_input_tokens_is_range_checked() {
        for bad in ["15", "4097", "0", "abc", "-1"] {
            let err = mock(&[(MAX_INPUT_TOKENS, bad)]).unwrap_err();
            assert!(err.to_string().contains(MAX_INPUT_TOKENS), "{bad}: {err}");
        }
        for (ok, expected) in [("16", 16), ("4096", 4096), ("128", 128)] {
            assert_eq!(
                mock(&[(MAX_INPUT_TOKENS, ok)]).unwrap().max_input_tokens,
                expected
            );
        }
    }

    #[test]
    fn max_context_tokens_defaults_and_accepts_custom_values() {
        assert_eq!(mock(&[]).unwrap().max_context_tokens, 4000);
        for (ok, expected) in [("0", 0), ("500", 500), ("32000", 32000)] {
            assert_eq!(
                mock(&[(MAX_CONTEXT_TOKENS, ok)])
                    .unwrap()
                    .max_context_tokens,
                expected
            );
        }
    }

    #[test]
    fn max_context_tokens_out_of_range_names_its_variable() {
        for bad in ["50000", "32001", "-1", "abc", "1.5"] {
            let err = mock(&[(MAX_CONTEXT_TOKENS, bad)]).unwrap_err();
            assert!(err.to_string().contains(MAX_CONTEXT_TOKENS), "{bad}: {err}");
        }
    }

    #[test]
    fn other_invalid_values_name_their_variable() {
        for (var, value) in [
            (BIND_ADDR, "not-an-address"),
            (GENERATION_TIMEOUT_SECS, "0"),
            (GENERATION_TIMEOUT_SECS, "soon"),
            (CORS_ORIGINS, "*"),
            (CORS_ORIGINS, "http://ok.example,bad\nvalue"),
        ] {
            let err = mock(&[(var, value)]).unwrap_err();
            assert!(err.to_string().contains(var), "{var}={value}: {err}");
        }
    }

    #[test]
    fn provider_specific_settings_are_parsed() {
        let c = Config::from_lookup(lookup(&[
            (AI_PROVIDER, "Ollama"),
            (OLLAMA_URL, "http://gpu-box:11434/"),
            (OLLAMA_MODEL, "llama3.1:8b"),
            (CODEX_BIN, "/opt/bin/codex"),
            (CODEX_MODEL, "gpt-5"),
            (CORS_ORIGINS, "http://a.example, http://b.example/"),
            (GENERATION_TIMEOUT_SECS, "120"),
        ]))
        .unwrap();
        assert_eq!(c.ai_provider, ProviderKind::Ollama);
        assert_eq!(c.ollama_url, "http://gpu-box:11434");
        assert_eq!(c.ollama_model, "llama3.1:8b");
        assert_eq!(c.codex_bin, "/opt/bin/codex");
        assert_eq!(c.codex_model.as_deref(), Some("gpt-5"));
        assert_eq!(c.cors_origins, ["http://a.example", "http://b.example"]);
        assert_eq!(c.generation_timeout, Duration::from_secs(120));
    }

    #[test]
    fn debug_output_never_contains_the_api_key() {
        let key = "sk-ant-super-secret-value";
        let c = Config::from_lookup(lookup(&[(AI_PROVIDER, "claude"), (ANTHROPIC_API_KEY, key)]))
            .unwrap();
        assert_eq!(c.anthropic_api_key.as_ref().unwrap().expose_secret(), key);
        assert!(!format!("{c:?}").contains(key));
        assert!(!format!("{c:#?}").contains(key));
    }

    /// Guards task 1.6: an undocumented or unread variable is a silent misconfiguration.
    #[test]
    fn env_example_documents_exactly_the_variables_config_reads() {
        let example = include_str!("../../../.env.example");
        let pairs: Vec<(String, String)> = example
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .collect();
        let mut documented: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
        let mut read = ALL_VARIABLES.to_vec();
        documented.sort_unstable();
        read.sort_unstable();
        assert_eq!(documented, read);

        let get = |k: &str| {
            pairs
                .iter()
                .find(|(name, _)| name == k)
                .map(|(_, v)| v.clone())
        };
        let c = Config::from_lookup(get).expect("the example config is itself valid");
        assert_eq!(c.ai_provider, ProviderKind::Ollama);
        assert_eq!(c.max_input_tokens, 256);
    }

    #[test]
    fn every_read_variable_influences_config() {
        let all = [
            (BIND_ADDR, "127.0.0.1:9999"),
            (AI_PROVIDER, "mock"),
            (ANTHROPIC_API_KEY, "k"),
            (AI_MODEL, "m"),
            (CORS_ORIGINS, "http://x.example"),
            (GENERATION_TIMEOUT_SECS, "7"),
            (MAX_INPUT_TOKENS, "99"),
            (MAX_CONTEXT_TOKENS, "1234"),
            (OLLAMA_URL, "http://o"),
            (OLLAMA_MODEL, "om"),
            (CODEX_BIN, "cb"),
            (CODEX_MODEL, "cm"),
            (DATABASE_URL, "postgres://u:p@h/d"),
            (DATABASE_MAX_CONNECTIONS, "25"),
        ];
        assert_eq!(all.len(), ALL_VARIABLES.len());
        let c = Config::from_lookup(lookup(&all)).unwrap();
        assert_eq!(c.bind_addr.port(), 9999);
        assert_eq!(c.ai_model, "m");
        assert_eq!(c.cors_origins, ["http://x.example"]);
        assert_eq!(c.generation_timeout.as_secs(), 7);
        assert_eq!(c.max_input_tokens, 99);
        assert_eq!(c.max_context_tokens, 1234);
        assert_eq!(c.ollama_url, "http://o");
        assert_eq!(c.ollama_model, "om");
        assert_eq!(c.codex_bin, "cb");
        assert_eq!(c.codex_model.as_deref(), Some("cm"));
        assert!(c.anthropic_api_key.is_some());
        assert_eq!(
            c.database.url.as_ref().unwrap().expose_secret(),
            "postgres://u:p@h/d"
        );
        assert_eq!(c.database.max_connections, 25);
    }

    #[test]
    fn blank_database_url_means_the_sqlite_default() {
        assert!(mock(&[]).unwrap().database.url.is_none());
        assert!(mock(&[(DATABASE_URL, "   ")])
            .unwrap()
            .database
            .url
            .is_none());
        assert_eq!(mock(&[]).unwrap().database.max_connections, 10);
    }

    #[test]
    fn database_pool_size_is_range_checked() {
        for bad in ["0", "101", "-1", "many", "1.5"] {
            let err = mock(&[(DATABASE_MAX_CONNECTIONS, bad)]).unwrap_err();
            assert!(
                err.to_string().contains(DATABASE_MAX_CONNECTIONS),
                "{bad}: {err}"
            );
        }
        for (ok, expected) in [("1", 1), ("100", 100)] {
            assert_eq!(
                mock(&[(DATABASE_MAX_CONNECTIONS, ok)])
                    .unwrap()
                    .database
                    .max_connections,
                expected
            );
        }
    }

    #[test]
    fn debug_output_never_contains_the_database_url() {
        let c = mock(&[(DATABASE_URL, "postgres://songbird:s3cret@db/songbird")]).unwrap();
        assert!(!format!("{c:?}").contains("s3cret"));
        assert!(!format!("{c:#?}").contains("s3cret"));
        assert!(!format!("{c:?}").contains("songbird:"));
    }
}
