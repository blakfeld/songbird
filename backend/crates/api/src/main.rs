use std::process::ExitCode;

use api::config::Config;
use api::startup::build_state;
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
    let bind_addr = config.bind_addr;
    let provider = config.ai_provider.as_str();
    let (max_input_tokens, max_context_tokens) =
        (config.max_input_tokens, config.max_context_tokens);
    let state = build_state(config).await?;

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("cannot listen on {bind_addr}: {e}"))?;
    tracing::info!(
        addr = %bind_addr,
        provider,
        max_input_tokens,
        max_context_tokens,
        database = ?state.db.backend(),
        "songbird api listening"
    );

    axum::serve(listener, api::app(state))
        .await
        .map_err(|e| e.to_string())
}
