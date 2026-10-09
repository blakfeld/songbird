//! Read once at startup and validated eagerly so a bad setting stops the
//! process with a message naming the variable instead of failing on a request.

use std::fmt;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use music::tokens::{
    DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_INPUT_TOKENS, MAX_MAX_CONTEXT_TOKENS,
    MAX_MAX_INPUT_TOKENS, MIN_MAX_INPUT_TOKENS,
};
use secrecy::{ExposeSecret, SecretBox, SecretString};

use crate::db::DatabaseConfig;

pub const BIND_ADDR: &str = "SONGBIRD_BIND_ADDR";
pub const AI_PROVIDER: &str = "SONGBIRD_AI_PROVIDER";
pub const ANTHROPIC_API_KEY: &str = "ANTHROPIC_API_KEY";
pub const AI_MODEL: &str = "SONGBIRD_AI_MODEL";
pub const CORS_ORIGINS: &str = "SONGBIRD_CORS_ORIGINS";
pub const GENERATION_TIMEOUT_SECS: &str = "SONGBIRD_GENERATION_TIMEOUT_SECS";
pub const MAX_CONCURRENT_GENERATIONS: &str = "SONGBIRD_MAX_CONCURRENT_GENERATIONS";
pub const MAX_INPUT_TOKENS: &str = "SONGBIRD_MAX_INPUT_TOKENS";
pub const MAX_CONTEXT_TOKENS: &str = "SONGBIRD_MAX_CONTEXT_TOKENS";
pub const OLLAMA_URL: &str = "SONGBIRD_OLLAMA_URL";
pub const OLLAMA_MODEL: &str = "SONGBIRD_OLLAMA_MODEL";
pub const CODEX_BIN: &str = "SONGBIRD_CODEX_BIN";
pub const CODEX_MODEL: &str = "SONGBIRD_CODEX_MODEL";
pub const DATABASE_URL: &str = "SONGBIRD_DATABASE_URL";
pub const DATABASE_MAX_CONNECTIONS: &str = "SONGBIRD_DATABASE_MAX_CONNECTIONS";
pub const COOKIE_SECURE: &str = "SONGBIRD_COOKIE_SECURE";
pub const SESSION_IDLE_HOURS: &str = "SONGBIRD_SESSION_IDLE_HOURS";
pub const TRUST_PROXY: &str = "SONGBIRD_TRUST_PROXY";
pub const AI_REQUESTS_PER_MINUTE: &str = "SONGBIRD_AI_REQUESTS_PER_MINUTE";
pub const AI_REQUESTS_PER_DAY: &str = "SONGBIRD_AI_REQUESTS_PER_DAY";
pub const ENV: &str = "SONGBIRD_ENV";
pub const MASTER_KEYS: &str = "SONGBIRD_MASTER_KEYS";
pub const OPENAI_MODEL: &str = "SONGBIRD_OPENAI_MODEL";
pub const SHARE_READS_PER_MINUTE: &str = "SONGBIRD_SHARE_READS_PER_MINUTE";
pub const COMMENTS_PER_ADDRESS_10M: &str = "SONGBIRD_COMMENTS_PER_ADDRESS_10M";
pub const COMMENTS_PER_ADDRESS_DAY: &str = "SONGBIRD_COMMENTS_PER_ADDRESS_DAY";
pub const COMMENTS_PER_SHARE_DAY: &str = "SONGBIRD_COMMENTS_PER_SHARE_DAY";

/// A test keeps `.env.example` in sync with this list so operators can discover every setting.
pub const ALL_VARIABLES: [&str; 27] = [
    BIND_ADDR,
    AI_PROVIDER,
    ANTHROPIC_API_KEY,
    AI_MODEL,
    CORS_ORIGINS,
    GENERATION_TIMEOUT_SECS,
    MAX_CONCURRENT_GENERATIONS,
    MAX_INPUT_TOKENS,
    MAX_CONTEXT_TOKENS,
    OLLAMA_URL,
    OLLAMA_MODEL,
    CODEX_BIN,
    CODEX_MODEL,
    DATABASE_URL,
    DATABASE_MAX_CONNECTIONS,
    COOKIE_SECURE,
    SESSION_IDLE_HOURS,
    TRUST_PROXY,
    AI_REQUESTS_PER_MINUTE,
    AI_REQUESTS_PER_DAY,
    ENV,
    MASTER_KEYS,
    OPENAI_MODEL,
    SHARE_READS_PER_MINUTE,
    COMMENTS_PER_ADDRESS_10M,
    COMMENTS_PER_ADDRESS_DAY,
    COMMENTS_PER_SHARE_DAY,
];

const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8080";
const DEFAULT_CORS_ORIGIN: &str = "http://localhost:3000";
const DEFAULT_AI_MODEL: &str = "claude-sonnet-5-5";
const DEFAULT_OPENAI_MODEL: &str = "gpt-4.1-mini";
const MASTER_KEY_BYTES: usize = 32;
const DEFAULT_TIMEOUT_SECS: u64 = 60;
/// A chat can make several provider calls, so a small number of concurrent
/// generations already saturates a local model or a personal API budget.
const DEFAULT_MAX_CONCURRENT_GENERATIONS: usize = 4;
const MAX_MAX_CONCURRENT_GENERATIONS: usize = 64;
const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5:7b-instruct";
const DEFAULT_CODEX_BIN: &str = "codex";
const DEFAULT_DATABASE_MAX_CONNECTIONS: u32 = 10;
const MAX_DATABASE_MAX_CONNECTIONS: u32 = 100;
const DEFAULT_SESSION_IDLE_HOURS: u32 = 168;
const MAX_SESSION_IDLE_HOURS: u32 = 720;
const DEFAULT_AI_REQUESTS_PER_MINUTE: u32 = 10;
const MAX_AI_REQUESTS_PER_MINUTE: u32 = 600;
const DEFAULT_AI_REQUESTS_PER_DAY: u32 = 200;
const MAX_AI_REQUESTS_PER_DAY: u32 = 100_000;
const DEFAULT_SHARE_READS_PER_MINUTE: u32 = 60;
const MAX_SHARE_READS_PER_MINUTE: u32 = 10_000;
const DEFAULT_COMMENTS_PER_ADDRESS_10M: u32 = 5;
const MAX_COMMENTS_PER_ADDRESS_10M: u32 = 1_000;
const DEFAULT_COMMENTS_PER_ADDRESS_DAY: u32 = 30;
const MAX_COMMENTS_PER_ADDRESS_DAY: u32 = 10_000;
const DEFAULT_COMMENTS_PER_SHARE_DAY: u32 = 200;
const MAX_COMMENTS_PER_SHARE_DAY: u32 = 100_000;

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
    /// The only mode production accepts, so no operator credential can serve a user's request.
    User,
    /// Lets tests and e2e run the real per-user code path without a real provider key.
    UserMock,
}

impl ProviderKind {
    pub fn is_per_user(self) -> bool {
        matches!(self, Self::User | Self::UserMock)
    }

    /// Error messages must tell the user whose account to check, and the user knows vendors by
    /// brand spelling rather than by config value.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Anthropic",
            Self::Ollama => "Ollama",
            Self::Codex => "Codex",
            Self::Mock => "the mock provider",
            Self::User | Self::UserMock => "your provider",
        }
    }
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Ollama => "ollama",
            Self::Codex => "codex",
            Self::Mock => "mock",
            Self::User => "user",
            Self::UserMock => "user-mock",
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
            "user" => Ok(Self::User),
            "user-mock" => Ok(Self::UserMock),
            other => Err(format!(
                "\"{other}\" is not a provider; use claude, ollama, codex, mock, user, or user-mock"
            )),
        }
    }
}

/// Production is the default so a deployment that forgets the setting fails closed
/// instead of falling back to an operator-paid provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Env {
    Production,
    Development,
}

impl FromStr for Env {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "production" => Ok(Self::Production),
            "development" => Ok(Self::Development),
            _ => Err("use production or development".into()),
        }
    }
}

/// Ordered newest first: the first entry encrypts, and a row's stored version picks
/// the entry that decrypts it so old keys keep working during rotation.
#[derive(Clone)]
pub struct Keyring {
    entries: Arc<[(String, SecretBox<[u8; MASTER_KEY_BYTES]>)]>,
}

impl Keyring {
    /// Errors never include the offending text, because it may be a real key.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let mut entries: Vec<(String, SecretBox<[u8; MASTER_KEY_BYTES]>)> = Vec::new();
        for (index, entry) in raw.split(',').enumerate() {
            let position = index + 1;
            let (version, encoded) = entry
                .trim()
                .split_once(':')
                .filter(|(v, k)| !v.is_empty() && !k.is_empty())
                .ok_or_else(|| {
                    format!("entry {position} is not <version>:<base64 key>, for example v1:<key>")
                })?;
            if !version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(format!(
                    "entry {position} has a version with characters other than letters, digits, - and _"
                ));
            }
            if entries.iter().any(|(v, _)| v == version) {
                return Err(format!("version \"{version}\" is listed more than once"));
            }
            let bytes = BASE64
                .decode(encoded)
                .map_err(|_| format!("entry {position} is not valid base64"))?;
            let key: [u8; MASTER_KEY_BYTES] = bytes
                .try_into()
                .map_err(|_| format!("entry {position} is not a {MASTER_KEY_BYTES}-byte key"))?;
            entries.push((version.to_string(), SecretBox::new(Box::new(key))));
        }
        Ok(Self {
            entries: entries.into(),
        })
    }

    pub fn current(&self) -> (&str, &[u8; MASTER_KEY_BYTES]) {
        let (version, key) = &self.entries[0];
        (version, key.expose_secret())
    }

    pub fn get(&self, version: &str) -> Option<&[u8; MASTER_KEY_BYTES]> {
        self.entries
            .iter()
            .find(|(v, _)| v == version)
            .map(|(_, key)| key.expose_secret())
    }

    pub fn versions(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(v, _)| v.as_str())
    }
}

impl fmt::Debug for Keyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keyring")
            .field("versions", &self.versions().collect::<Vec<_>>())
            .finish()
    }
}

/// `Debug` is safe to log: the API key, database URL and keyring redact themselves.
#[derive(Debug, Clone)]
pub struct Config {
    pub env: Env,
    pub bind_addr: SocketAddr,
    pub ai_provider: ProviderKind,
    pub anthropic_api_key: Option<SecretString>,
    pub ai_model: String,
    pub openai_model: String,
    pub master_keys: Option<Keyring>,
    pub cors_origins: Vec<String>,
    pub generation_timeout: Duration,
    pub max_concurrent_generations: usize,
    pub max_input_tokens: u32,
    pub max_context_tokens: u32,
    pub ollama_url: String,
    pub ollama_model: String,
    pub codex_bin: String,
    pub codex_model: Option<String>,
    pub database: DatabaseConfig,
    pub cookie_secure: bool,
    pub session_idle: Duration,
    pub client_address_source: ClientAddressSource,
    pub ai_requests_per_minute: u32,
    pub ai_requests_per_day: u32,
    pub share_reads_per_minute: u32,
    pub comments_per_address_10m: u32,
    pub comments_per_address_day: u32,
    pub comments_per_share_day: u32,
}

fn has_https_origin(origins: &[String]) -> bool {
    origins.iter().any(|o| o.starts_with("https://"))
}

/// Where the per-address throttles read the caller's address from. Only a proxy that
/// overwrites or appends the chosen header makes it safe, so the default ignores headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientAddressSource {
    Peer,
    /// The rightmost entry, because that is the one the trusted proxy appended; entries
    /// to its left are whatever the client sent.
    XForwardedFor,
    FlyClientIp,
}

fn parse_client_address_source(value: Option<String>) -> Result<ClientAddressSource, ConfigError> {
    match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
        None | Some("false") => Ok(ClientAddressSource::Peer),
        Some("true" | "x-forwarded-for") => Ok(ClientAddressSource::XForwardedFor),
        Some("fly-client-ip") => Ok(ClientAddressSource::FlyClientIp),
        Some(other) => Err(ConfigError::Invalid {
            var: TRUST_PROXY,
            problem: format!("\"{other}\" is not false, true, x-forwarded-for or fly-client-ip"),
        }),
    }
}

fn parse_bool(
    var: &'static str,
    value: Option<String>,
    default: bool,
) -> Result<bool, ConfigError> {
    match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(other) => Err(ConfigError::Invalid {
            var,
            problem: format!("\"{other}\" is not true or false"),
        }),
    }
}

fn parse_ranged(
    var: &'static str,
    value: Option<String>,
    default: u32,
    max: u32,
) -> Result<u32, ConfigError> {
    let Some(v) = value else { return Ok(default) };
    v.parse::<u32>()
        .ok()
        .filter(|n| (1..=max).contains(n))
        .ok_or_else(|| ConfigError::Invalid {
            var,
            problem: format!("\"{v}\" is not an integer between 1 and {max}"),
        })
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

        let env = match get(ENV) {
            None => Env::Production,
            Some(v) => v.parse().map_err(|p: String| invalid(ENV, p))?,
        };

        let bind_addr = get(BIND_ADDR).unwrap_or_else(|| DEFAULT_BIND_ADDR.into());
        let bind_addr = bind_addr
            .parse::<SocketAddr>()
            .map_err(|e| invalid(BIND_ADDR, format!("\"{bind_addr}\" is not host:port ({e})")))?;

        let ai_provider = match (get(AI_PROVIDER), env) {
            (None, Env::Production) => ProviderKind::User,
            (None, Env::Development) => ProviderKind::Claude,
            (Some(v), _) => v.parse().map_err(|p| invalid(AI_PROVIDER, p))?,
        };
        if env == Env::Production && ai_provider != ProviderKind::User {
            return Err(invalid(
                AI_PROVIDER,
                format!(
                    "{} is not allowed while {ENV} is production; production requires per-user keys, so use user or set {ENV}=development",
                    ai_provider.as_str()
                ),
            ));
        }

        let anthropic_api_key = get(ANTHROPIC_API_KEY).map(SecretString::from);
        if env == Env::Production && anthropic_api_key.is_some() {
            return Err(invalid(
                ANTHROPIC_API_KEY,
                format!(
                    "must not be set while {ENV} is production; production uses each user's own key, so remove it"
                ),
            ));
        }
        if ai_provider == ProviderKind::Claude && anthropic_api_key.is_none() {
            return Err(ConfigError::Missing {
                var: ANTHROPIC_API_KEY,
                reason: "SONGBIRD_AI_PROVIDER=claude",
            });
        }

        let master_keys = get(MASTER_KEYS)
            .map(|raw| Keyring::parse(&raw).map_err(|p| invalid(MASTER_KEYS, p)))
            .transpose()?;
        if master_keys.is_none() && (env == Env::Production || ai_provider.is_per_user()) {
            return Err(ConfigError::Missing {
                var: MASTER_KEYS,
                reason: "running in production or with SONGBIRD_AI_PROVIDER=user or user-mock",
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

        let max_concurrent_generations = match get(MAX_CONCURRENT_GENERATIONS) {
            None => DEFAULT_MAX_CONCURRENT_GENERATIONS,
            Some(v) => v
                .parse::<usize>()
                .ok()
                .filter(|n| (1..=MAX_MAX_CONCURRENT_GENERATIONS).contains(n))
                .ok_or_else(|| {
                    invalid(
                        MAX_CONCURRENT_GENERATIONS,
                        format!(
                            "\"{v}\" is not an integer between 1 and {MAX_MAX_CONCURRENT_GENERATIONS}"
                        ),
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

        let database = database_from_get(&get)?;

        let cookie_secure = parse_bool(COOKIE_SECURE, get(COOKIE_SECURE), true)?;
        // A non-Secure session cookie on a real https deployment would travel over any
        // accidental http request, so refuse rather than run exposed.
        if !cookie_secure && has_https_origin(&cors_origins) {
            return Err(invalid(
                COOKIE_SECURE,
                format!("false is not allowed while {CORS_ORIGINS} contains an https:// origin"),
            ));
        }
        let session_idle_hours = parse_ranged(
            SESSION_IDLE_HOURS,
            get(SESSION_IDLE_HOURS),
            DEFAULT_SESSION_IDLE_HOURS,
            MAX_SESSION_IDLE_HOURS,
        )?;
        let client_address_source = parse_client_address_source(get(TRUST_PROXY))?;
        let ai_requests_per_minute = parse_ranged(
            AI_REQUESTS_PER_MINUTE,
            get(AI_REQUESTS_PER_MINUTE),
            DEFAULT_AI_REQUESTS_PER_MINUTE,
            MAX_AI_REQUESTS_PER_MINUTE,
        )?;
        let ai_requests_per_day = parse_ranged(
            AI_REQUESTS_PER_DAY,
            get(AI_REQUESTS_PER_DAY),
            DEFAULT_AI_REQUESTS_PER_DAY,
            MAX_AI_REQUESTS_PER_DAY,
        )?;
        let share_reads_per_minute = parse_ranged(
            SHARE_READS_PER_MINUTE,
            get(SHARE_READS_PER_MINUTE),
            DEFAULT_SHARE_READS_PER_MINUTE,
            MAX_SHARE_READS_PER_MINUTE,
        )?;
        let comments_per_address_10m = parse_ranged(
            COMMENTS_PER_ADDRESS_10M,
            get(COMMENTS_PER_ADDRESS_10M),
            DEFAULT_COMMENTS_PER_ADDRESS_10M,
            MAX_COMMENTS_PER_ADDRESS_10M,
        )?;
        let comments_per_address_day = parse_ranged(
            COMMENTS_PER_ADDRESS_DAY,
            get(COMMENTS_PER_ADDRESS_DAY),
            DEFAULT_COMMENTS_PER_ADDRESS_DAY,
            MAX_COMMENTS_PER_ADDRESS_DAY,
        )?;
        let comments_per_share_day = parse_ranged(
            COMMENTS_PER_SHARE_DAY,
            get(COMMENTS_PER_SHARE_DAY),
            DEFAULT_COMMENTS_PER_SHARE_DAY,
            MAX_COMMENTS_PER_SHARE_DAY,
        )?;

        Ok(Self {
            env,
            bind_addr,
            ai_provider,
            anthropic_api_key,
            ai_model: get(AI_MODEL).unwrap_or_else(|| DEFAULT_AI_MODEL.into()),
            openai_model: get(OPENAI_MODEL).unwrap_or_else(|| DEFAULT_OPENAI_MODEL.into()),
            master_keys,
            cors_origins,
            generation_timeout: Duration::from_secs(timeout_secs),
            max_concurrent_generations,
            max_input_tokens,
            max_context_tokens,
            ollama_url: get(OLLAMA_URL)
                .unwrap_or_else(|| DEFAULT_OLLAMA_URL.into())
                .trim_end_matches('/')
                .to_string(),
            ollama_model: get(OLLAMA_MODEL).unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.into()),
            codex_bin: get(CODEX_BIN).unwrap_or_else(|| DEFAULT_CODEX_BIN.into()),
            codex_model: get(CODEX_MODEL),
            database,
            cookie_secure,
            session_idle: Duration::from_secs(u64::from(session_idle_hours) * 3600),
            client_address_source,
            ai_requests_per_minute,
            ai_requests_per_day,
            share_reads_per_minute,
            comments_per_address_10m,
            comments_per_address_day,
            comments_per_share_day,
        })
    }

    /// Settings that are legal but probably wrong; returned rather than logged so a
    /// test can assert them without capturing a subscriber.
    pub fn startup_warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        if self.env == Env::Development {
            warnings.push(format!(
                "running in development mode ({ENV}=development); operator-paid AI providers are allowed, which must never serve real users"
            ));
        }
        if self.client_address_source == ClientAddressSource::Peer
            && has_https_origin(&self.cors_origins)
        {
            warnings.push(format!(
                "{TRUST_PROXY} is false while {CORS_ORIGINS} has an https:// origin; behind a reverse proxy every client then shares the proxy's address, so one stranger can trip the login throttle for everyone"
            ));
        }
        if self.env == Env::Production && self.client_address_source == ClientAddressSource::Peer {
            warnings.push(format!(
                "{TRUST_PROXY} is false in production; behind a reverse proxy every share-link listener then shares the proxy's address, so one stranger can exhaust the listen and comment limits for everyone"
            ));
        }
        warnings
    }
}

/// Key commands need the keyring and the database but not the provider settings, which may be
/// invalid for a host that only runs maintenance.
pub fn master_keys_from_lookup(
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<Option<Keyring>, ConfigError> {
    lookup(MASTER_KEYS)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|raw| {
            Keyring::parse(&raw).map_err(|problem| ConfigError::Invalid {
                var: MASTER_KEYS,
                problem,
            })
        })
        .transpose()
}

/// The operator CLI needs only the database, and must not fail on unrelated
/// provider settings such as a missing API key.
pub fn database_from_lookup(
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<DatabaseConfig, ConfigError> {
    database_from_get(&|var: &str| {
        lookup(var)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

fn database_from_get(get: &impl Fn(&str) -> Option<String>) -> Result<DatabaseConfig, ConfigError> {
    let max_connections = match get(DATABASE_MAX_CONNECTIONS) {
        None => DEFAULT_DATABASE_MAX_CONNECTIONS,
        Some(v) => v
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=MAX_DATABASE_MAX_CONNECTIONS).contains(n))
            .ok_or_else(|| ConfigError::Invalid {
                var: DATABASE_MAX_CONNECTIONS,
                problem: format!(
                    "\"{v}\" is not an integer between 1 and {MAX_DATABASE_MAX_CONNECTIONS}"
                ),
            })?,
    };
    Ok(DatabaseConfig {
        url: get(DATABASE_URL).map(SecretString::from),
        max_connections,
    })
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

    const KEY_A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    fn key_b() -> String {
        BASE64.encode([1u8; 32])
    }

    fn mock(extra: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let mut pairs = vec![(ENV, "development"), (AI_PROVIDER, "mock")];
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
        let err = Config::from_lookup(lookup(&[(ENV, "development")])).unwrap_err();
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
            (ENV, "development"),
            (AI_PROVIDER, "claude"),
            (ANTHROPIC_API_KEY, "  "),
        ]))
        .unwrap_err();
        assert!(err.to_string().contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn unknown_provider_names_the_variable() {
        let err =
            Config::from_lookup(lookup(&[(ENV, "development"), (AI_PROVIDER, "gpt")])).unwrap_err();
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
    fn max_concurrent_generations_defaults_and_is_range_checked() {
        assert_eq!(mock(&[]).unwrap().max_concurrent_generations, 4);
        for bad in ["0", "65", "-1", "abc"] {
            let err = mock(&[(MAX_CONCURRENT_GENERATIONS, bad)]).unwrap_err();
            assert!(
                err.to_string().contains(MAX_CONCURRENT_GENERATIONS),
                "{bad}: {err}"
            );
        }
        let c = mock(&[(MAX_CONCURRENT_GENERATIONS, "64")]).unwrap();
        assert_eq!(c.max_concurrent_generations, 64);
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
            (ENV, "development"),
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
        let c = Config::from_lookup(lookup(&[
            (ENV, "development"),
            (AI_PROVIDER, "claude"),
            (ANTHROPIC_API_KEY, key),
        ]))
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
            (ENV, "development"),
            (MASTER_KEYS, "v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
            (OPENAI_MODEL, "om2"),
            (BIND_ADDR, "127.0.0.1:9999"),
            (AI_PROVIDER, "mock"),
            (ANTHROPIC_API_KEY, "k"),
            (AI_MODEL, "m"),
            (CORS_ORIGINS, "http://x.example"),
            (GENERATION_TIMEOUT_SECS, "7"),
            (MAX_CONCURRENT_GENERATIONS, "3"),
            (MAX_INPUT_TOKENS, "99"),
            (MAX_CONTEXT_TOKENS, "1234"),
            (OLLAMA_URL, "http://o"),
            (OLLAMA_MODEL, "om"),
            (CODEX_BIN, "cb"),
            (CODEX_MODEL, "cm"),
            (DATABASE_URL, "postgres://u:p@h/d"),
            (DATABASE_MAX_CONNECTIONS, "25"),
            (COOKIE_SECURE, "false"),
            (SESSION_IDLE_HOURS, "24"),
            (TRUST_PROXY, "true"),
            (AI_REQUESTS_PER_MINUTE, "7"),
            (AI_REQUESTS_PER_DAY, "70"),
            (SHARE_READS_PER_MINUTE, "11"),
            (COMMENTS_PER_ADDRESS_10M, "2"),
            (COMMENTS_PER_ADDRESS_DAY, "9"),
            (COMMENTS_PER_SHARE_DAY, "33"),
        ];
        assert_eq!(all.len(), ALL_VARIABLES.len());
        let c = Config::from_lookup(lookup(&all)).unwrap();
        assert_eq!(c.bind_addr.port(), 9999);
        assert_eq!(c.ai_model, "m");
        assert_eq!(c.env, Env::Development);
        assert_eq!(c.openai_model, "om2");
        assert_eq!(
            c.master_keys
                .as_ref()
                .unwrap()
                .versions()
                .collect::<Vec<_>>(),
            ["v2", "v1"]
        );
        assert_eq!(c.cors_origins, ["http://x.example"]);
        assert_eq!(c.generation_timeout.as_secs(), 7);
        assert_eq!(c.max_concurrent_generations, 3);
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
        assert!(!c.cookie_secure);
        assert_eq!(c.session_idle, Duration::from_secs(24 * 3600));
        assert_eq!(c.client_address_source, ClientAddressSource::XForwardedFor);
        assert_eq!(c.ai_requests_per_minute, 7);
        assert_eq!(c.ai_requests_per_day, 70);
        assert_eq!(c.share_reads_per_minute, 11);
        assert_eq!(c.comments_per_address_10m, 2);
        assert_eq!(c.comments_per_address_day, 9);
        assert_eq!(c.comments_per_share_day, 33);
    }

    #[test]
    fn share_limits_default_to_the_documented_values_and_are_range_checked() {
        let c = mock(&[]).unwrap();
        assert_eq!(
            (
                c.share_reads_per_minute,
                c.comments_per_address_10m,
                c.comments_per_address_day,
                c.comments_per_share_day
            ),
            (60, 5, 30, 200)
        );
        for var in [
            SHARE_READS_PER_MINUTE,
            COMMENTS_PER_ADDRESS_10M,
            COMMENTS_PER_ADDRESS_DAY,
            COMMENTS_PER_SHARE_DAY,
        ] {
            for bad in ["0", "-1", "x", "100000000"] {
                let err = mock(&[(var, bad)]).unwrap_err().to_string();
                assert!(err.contains(var), "{err}");
            }
        }
    }

    #[test]
    fn production_without_a_trusted_proxy_warns_about_the_share_throttle() {
        let warns = |c: Config| {
            c.startup_warnings()
                .iter()
                .any(|w| w.contains("share-link listener"))
        };
        assert!(warns(production(&[]).unwrap()));
        for mode in ["true", "x-forwarded-for", "fly-client-ip"] {
            assert!(
                !warns(production(&[(TRUST_PROXY, mode)]).unwrap()),
                "{mode}"
            );
        }
        assert!(!warns(mock(&[]).unwrap()));
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

    #[test]
    fn account_settings_default_safely() {
        let c = mock(&[]).unwrap();
        assert!(c.cookie_secure);
        assert_eq!(c.session_idle, Duration::from_secs(168 * 3600));
        assert_eq!(c.client_address_source, ClientAddressSource::Peer);
        assert_eq!(c.ai_requests_per_minute, 10);
        assert_eq!(c.ai_requests_per_day, 200);
    }

    #[test]
    fn session_idle_hours_and_ai_limits_are_range_checked() {
        for (var, bad) in [
            (SESSION_IDLE_HOURS, "0"),
            (SESSION_IDLE_HOURS, "721"),
            (SESSION_IDLE_HOURS, "soon"),
            (AI_REQUESTS_PER_MINUTE, "0"),
            (AI_REQUESTS_PER_MINUTE, "601"),
            (AI_REQUESTS_PER_DAY, "0"),
            (AI_REQUESTS_PER_DAY, "100001"),
            (AI_REQUESTS_PER_DAY, "-1"),
            (COOKIE_SECURE, "maybe"),
            (TRUST_PROXY, "1"),
        ] {
            let err = mock(&[(var, bad)]).unwrap_err();
            assert!(err.to_string().contains(var), "{var}={bad}: {err}");
        }
        assert_eq!(
            mock(&[(SESSION_IDLE_HOURS, "720")]).unwrap().session_idle,
            Duration::from_secs(720 * 3600)
        );
        assert_eq!(
            mock(&[(AI_REQUESTS_PER_DAY, "100000")])
                .unwrap()
                .ai_requests_per_day,
            100_000
        );
    }

    #[test]
    fn insecure_cookie_with_an_https_origin_is_refused_naming_both_variables() {
        let err = mock(&[
            (COOKIE_SECURE, "false"),
            (
                CORS_ORIGINS,
                "http://localhost:3000,https://songbird.example",
            ),
        ])
        .unwrap_err();
        let message = err.to_string();
        assert!(message.contains(COOKIE_SECURE), "{message}");
        assert!(message.contains(CORS_ORIGINS), "{message}");

        assert!(mock(&[(COOKIE_SECURE, "false")]).is_ok());
        assert!(mock(&[(CORS_ORIGINS, "https://songbird.example")]).is_ok());
    }

    #[test]
    fn trust_proxy_accepts_the_documented_values_in_any_case() {
        for (value, expected) in [
            ("false", ClientAddressSource::Peer),
            ("true", ClientAddressSource::XForwardedFor),
            ("X-Forwarded-For", ClientAddressSource::XForwardedFor),
            ("Fly-Client-IP", ClientAddressSource::FlyClientIp),
        ] {
            let c = mock(&[(TRUST_PROXY, value)]).unwrap();
            assert_eq!(c.client_address_source, expected, "{value}");
        }
        let err = mock(&[(TRUST_PROXY, "cloudflare")]).unwrap_err();
        assert!(err.to_string().contains(TRUST_PROXY), "{err}");
    }

    #[test]
    fn untrusted_proxy_with_an_https_origin_warns() {
        let proxy_warnings = |c: Config| {
            c.startup_warnings()
                .into_iter()
                .filter(|w| w.contains(TRUST_PROXY))
                .count()
        };
        assert_eq!(
            proxy_warnings(mock(&[(CORS_ORIGINS, "https://songbird.example")]).unwrap()),
            1
        );

        for config in [
            mock(&[
                (CORS_ORIGINS, "https://songbird.example"),
                (TRUST_PROXY, "true"),
            ])
            .unwrap(),
            mock(&[]).unwrap(),
        ] {
            assert_eq!(proxy_warnings(config), 0);
        }
    }

    fn production(extra: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let mut pairs = vec![(MASTER_KEYS, KEY_A_ENTRY)];
        pairs.extend_from_slice(extra);
        Config::from_lookup(lookup(&pairs))
    }

    const KEY_A_ENTRY: &str = "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    #[test]
    fn unset_env_means_production_with_per_user_keys() {
        let c = production(&[]).unwrap();
        assert_eq!(c.env, Env::Production);
        assert_eq!(c.ai_provider, ProviderKind::User);
        let trusted = production(&[(TRUST_PROXY, "true")]).unwrap();
        assert!(trusted.startup_warnings().is_empty());
    }

    #[test]
    fn unknown_env_names_the_variable_without_echoing_the_value() {
        for bad in ["prod", "staging", "dev", "1"] {
            let err = production(&[(ENV, bad)]).unwrap_err().to_string();
            assert!(err.contains(ENV), "{err}");
            assert!(!err.contains(&format!("\"{bad}\"")), "{err}");
        }
        assert_eq!(
            production(&[(ENV, "Production")]).unwrap().env,
            Env::Production
        );
    }

    #[test]
    fn production_rejects_every_provider_but_user() {
        for provider in ["claude", "ollama", "codex", "mock", "user-mock"] {
            let err = production(&[(AI_PROVIDER, provider)])
                .unwrap_err()
                .to_string();
            assert!(err.contains(AI_PROVIDER), "{provider}: {err}");
            assert!(err.contains(ENV), "{provider}: {err}");
            assert!(err.contains("per-user keys"), "{provider}: {err}");
        }
        assert_eq!(
            production(&[(AI_PROVIDER, "user")]).unwrap().ai_provider,
            ProviderKind::User
        );
    }

    #[test]
    fn production_rejects_an_operator_key_without_echoing_it() {
        let secret = "sk-ant-leftover-operator-key";
        for provider in [None, Some("user")] {
            let mut extra = vec![(ANTHROPIC_API_KEY, secret)];
            if let Some(p) = provider {
                extra.push((AI_PROVIDER, p));
            }
            let err = production(&extra).unwrap_err().to_string();
            assert!(err.contains(ANTHROPIC_API_KEY), "{err}");
            assert!(err.contains("each user's own key"), "{err}");
            assert!(!err.contains(secret), "{err}");
        }
        assert!(production(&[(ANTHROPIC_API_KEY, "   ")]).is_ok());
    }

    #[test]
    fn production_requires_a_keyring() {
        for pairs in [vec![], vec![(MASTER_KEYS, "  ")], vec![(ENV, "production")]] {
            let err = Config::from_lookup(lookup(&pairs)).unwrap_err();
            assert!(err.to_string().contains(MASTER_KEYS), "{err}");
        }
    }

    #[test]
    fn per_user_providers_require_a_keyring_even_in_development() {
        for provider in ["user", "user-mock"] {
            let err = Config::from_lookup(lookup(&[(ENV, "development"), (AI_PROVIDER, provider)]))
                .unwrap_err();
            assert!(err.to_string().contains(MASTER_KEYS), "{provider}: {err}");

            let c = Config::from_lookup(lookup(&[
                (ENV, "development"),
                (AI_PROVIDER, provider),
                (MASTER_KEYS, KEY_A_ENTRY),
            ]))
            .unwrap();
            assert!(c.ai_provider.is_per_user());
        }
    }

    #[test]
    fn development_allows_operator_providers_without_a_keyring() {
        let c = mock(&[]).unwrap();
        assert!(c.master_keys.is_none());
        assert_eq!(c.openai_model, "gpt-4.1-mini");
        let c = Config::from_lookup(lookup(&[(ENV, "development")]));
        assert_eq!(
            c.unwrap_err().to_string(),
            "ANTHROPIC_API_KEY is required when SONGBIRD_AI_PROVIDER=claude"
        );
    }

    #[test]
    fn development_mode_warns_at_startup() {
        let warnings = mock(&[]).unwrap().startup_warnings();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("development mode"));
        assert!(warnings[0].contains(ENV));
    }

    #[test]
    fn a_malformed_keyring_is_rejected_in_development_too() {
        let err = mock(&[(MASTER_KEYS, "v1:short")]).unwrap_err().to_string();
        assert!(err.contains(MASTER_KEYS), "{err}");
        assert!(!err.contains("short"), "{err}");
    }

    #[test]
    fn keyring_parses_in_order_and_looks_up_by_version() {
        let ring = Keyring::parse(&format!("v2:{}, v1:{KEY_A}", key_b())).unwrap();
        assert_eq!(ring.versions().collect::<Vec<_>>(), ["v2", "v1"]);
        let (version, key) = ring.current();
        assert_eq!(version, "v2");
        assert_eq!(key, &[1u8; 32]);
        assert_eq!(ring.get("v1"), Some(&[0u8; 32]));
        assert_eq!(ring.get("v3"), None);
    }

    #[test]
    fn keyring_rejects_bad_input_without_echoing_it() {
        let short = BASE64.encode([1u8; 16]);
        let long = BASE64.encode([1u8; 33]);
        let dup = format!("v1:{KEY_A},v1:{}", key_b());
        let cases = [
            ("", "empty list"),
            ("   ", "blank"),
            ("v1", "no colon"),
            (":AAAA", "no version"),
            ("v1:", "no key"),
            ("v1:not base64!!", "bad base64"),
            ("v1:c2VjcmV0LXRoYXQtaXMtbm90LTMyLWJ5dGVz", "wrong length"),
            (short.as_str(), "no version prefix"),
            (dup.as_str(), "duplicate"),
            (
                "v 1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "bad version",
            ),
            (
                "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,",
                "trailing comma",
            ),
        ];
        for (raw, label) in cases {
            let err = Keyring::parse(raw).unwrap_err();
            assert!(
                !err.contains(KEY_A) && !err.contains(&key_b()),
                "{label}: {err}"
            );
        }
        for raw in [format!("v1:{short}"), format!("v1:{long}")] {
            let err = Keyring::parse(&raw).unwrap_err();
            assert!(err.contains("32-byte"), "{err}");
            assert!(!err.contains(raw.trim_start_matches("v1:")), "{err}");
        }
    }

    #[test]
    fn debug_output_never_contains_master_key_material() {
        let raw_a = [0xA5u8; 32];
        let raw_b = [0x3Cu8; 32];
        let (enc_a, enc_b) = (BASE64.encode(raw_a), BASE64.encode(raw_b));
        let c = mock(&[(MASTER_KEYS, &format!("v2:{enc_a},v1:{enc_b}"))]).unwrap();
        for rendered in [format!("{c:?}"), format!("{c:#?}")] {
            assert!(
                rendered.contains("v2") && rendered.contains("v1"),
                "{rendered}"
            );
            for needle in [&enc_a, &enc_b, &format!("{raw_a:?}"), &format!("{raw_b:?}")] {
                assert!(!rendered.contains(needle.as_str()), "{rendered}");
            }
        }
    }
}
