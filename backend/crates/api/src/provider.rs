use std::sync::Arc;

use music::ai::{
    ClaudeProvider, CodexCliProvider, MockProvider, OllamaProvider, PatternProvider, ProviderError,
    SchemaProvider,
};

use crate::config::{Config, ProviderKind, ANTHROPIC_API_KEY, BIND_ADDR};

/// Fails startup, rather than the first request, when the selected provider is
/// unusable; every message says how to fix it.
pub async fn build_provider(config: &Config) -> Result<Arc<dyn PatternProvider>, ProviderError> {
    let provider: Arc<dyn PatternProvider> = match config.ai_provider {
        ProviderKind::Claude => {
            let key = config.anthropic_api_key.clone().ok_or_else(|| {
                ProviderError::Unavailable(format!(
                    "{ANTHROPIC_API_KEY} is required when SONGBIRD_AI_PROVIDER=claude"
                ))
            })?;
            Arc::new(SchemaProvider::new(ClaudeProvider::new(
                key,
                config.ai_model.clone(),
            )))
        }
        ProviderKind::Ollama => Arc::new(SchemaProvider::new(OllamaProvider::new(
            config.ollama_url.clone(),
            config.ollama_model.clone(),
        ))),
        ProviderKind::Codex => {
            require_loopback_for_codex(config)?;
            tracing::warn!(
                "the codex provider uses a personal ChatGPT subscription and is for local testing only"
            );
            Arc::new(SchemaProvider::new(CodexCliProvider::new(
                config.codex_bin.clone(),
                config.codex_model.clone(),
            )))
        }
        ProviderKind::Mock => Arc::new(MockProvider),
    };
    provider.check().await?;
    Ok(provider)
}

/// Exposing this provider on a network would let strangers spend the
/// operator's personal plan quota.
fn require_loopback_for_codex(config: &Config) -> Result<(), ProviderError> {
    if config.bind_addr.ip().is_loopback() {
        return Ok(());
    }
    Err(ProviderError::Unavailable(format!(
        "The codex provider is for local testing only and cannot listen on {}. \
         Set {BIND_ADDR} to a loopback address such as 127.0.0.1:8080.",
        config.bind_addr
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AI_PROVIDER, BIND_ADDR, CODEX_BIN, OLLAMA_MODEL, OLLAMA_URL};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config(pairs: &[(&str, &str)]) -> Config {
        Config::from_lookup(|k| {
            pairs
                .iter()
                .find(|(name, _)| *name == k)
                .map(|(_, v)| v.to_string())
        })
        .unwrap()
    }

    fn fake_codex(mode: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../music/tests/fixtures/fake_codex.sh");
        std::os::unix::fs::symlink(script, dir.path().join("codex")).unwrap();
        std::fs::write(dir.path().join("mode"), mode).unwrap();
        dir
    }

    async fn error_of(config: &Config) -> String {
        match build_provider(config).await {
            Ok(_) => panic!("expected startup to fail"),
            Err(e) => e.to_string(),
        }
    }

    #[tokio::test]
    async fn claude_without_a_key_names_the_variable() {
        let mut c = config(&[(AI_PROVIDER, "mock")]);
        c.ai_provider = ProviderKind::Claude;
        assert!(error_of(&c).await.contains("ANTHROPIC_API_KEY"));
    }

    #[tokio::test]
    async fn mock_starts_without_any_setup() {
        build_provider(&config(&[(AI_PROVIDER, "mock")]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn ollama_unreachable_names_the_url_and_says_to_start_it() {
        let server = MockServer::start().await;
        let url = server.uri();
        drop(server);
        let message = error_of(&config(&[(AI_PROVIDER, "ollama"), (OLLAMA_URL, &url)])).await;
        assert!(message.contains(&url));
        assert!(message.contains("ollama serve"));
    }

    #[tokio::test]
    async fn ollama_missing_model_says_to_pull_it() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"models": []})),
            )
            .mount(&server)
            .await;
        let message = error_of(&config(&[
            (AI_PROVIDER, "ollama"),
            (OLLAMA_URL, &server.uri()),
            (OLLAMA_MODEL, "tiny:1b"),
        ]))
        .await;
        assert!(message.contains("ollama pull tiny:1b"));
    }

    #[tokio::test]
    async fn codex_missing_cli_says_to_install_it() {
        let message = error_of(&config(&[
            (AI_PROVIDER, "codex"),
            (CODEX_BIN, "/nonexistent/codex"),
        ]))
        .await;
        assert!(message.contains("Install"));
    }

    #[tokio::test]
    async fn codex_signed_out_says_to_log_in() {
        let dir = fake_codex("signed_out");
        let bin = dir.path().join("codex");
        let message = error_of(&config(&[
            (AI_PROVIDER, "codex"),
            (CODEX_BIN, bin.to_str().unwrap()),
        ]))
        .await;
        assert!(message.contains("codex login"));
    }

    #[tokio::test]
    async fn codex_refuses_a_non_loopback_address() {
        let dir = fake_codex("ok");
        let bin = dir.path().join("codex");
        let message = error_of(&config(&[
            (AI_PROVIDER, "codex"),
            (CODEX_BIN, bin.to_str().unwrap()),
            (BIND_ADDR, "0.0.0.0:8080"),
        ]))
        .await;
        assert!(message.contains("local testing only"));
        assert!(message.contains("SONGBIRD_BIND_ADDR"));
    }
}
