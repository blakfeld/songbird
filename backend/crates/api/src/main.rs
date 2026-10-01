use std::process::ExitCode;
use std::sync::Arc;

use api::config::Config;
use api::provider::build_providers;
use api::state::AppState;
use music::InstrumentRegistry;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    // A missing .env is normal: production sets the environment directly.
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let config = Config::from_env().map_err(|e| e.to_string())?;
    let providers = build_providers(&config).await.map_err(|e| e.to_string())?;

    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .map_err(|e| format!("cannot listen on {}: {e}", config.bind_addr))?;
    tracing::info!(
        addr = %config.bind_addr,
        provider = config.ai_provider.as_str(),
        max_input_tokens = config.max_input_tokens,
        max_context_tokens = config.max_context_tokens,
        "songbird api listening"
    );

    let state = AppState {
        providers,
        instruments: InstrumentRegistry::builtin(),
        config: Arc::new(config),
    };
    axum::serve(listener, api::app(state))
        .await
        .map_err(|e| e.to_string())
}
