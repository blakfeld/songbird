use std::process::ExitCode;

use api::auth::password::PasswordService;
use api::cli::{self, Cli, Command};
use api::config::{database_from_lookup, Config};
use api::db::Db;
use api::startup::build_state;
use clap::Parser;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    // A missing .env is normal: production sets the environment directly.
    let _ = dotenvy::dotenv();

    let cli = Cli::parse();

    // Operator commands print their result on stdout, so logs go to stderr and stay quiet.
    let result = match cli.command {
        Some(Command::User(command)) => {
            tracing_subscriber::fmt()
                .with_writer(std::io::stderr)
                .with_env_filter(
                    EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
                )
                .init();
            run_user_command(command).await
        }
        None => {
            tracing_subscriber::fmt()
                .json()
                .with_env_filter(
                    EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
                )
                .init();
            serve().await
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run_user_command(command: cli::UserCommand) -> Result<(), String> {
    let database =
        database_from_lookup(|var| std::env::var(var).ok()).map_err(|e| e.to_string())?;
    let inputs = cli::read_inputs(&command).map_err(|e| e.to_string())?;
    let db = Db::connect(&database).await.map_err(|e| e.to_string())?;
    let output = cli::run_user_command(&db, &PasswordService::new(), command, inputs)
        .await
        .map_err(|e| e.to_string())?;
    println!("{output}");
    Ok(())
}

async fn serve() -> Result<(), String> {
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

    api::auth::session::spawn_sweeper(state.db.clone());

    // The peer address is what login throttling keys on when no proxy is trusted.
    axum::serve(
        listener,
        api::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .map_err(|e| e.to_string())
}
