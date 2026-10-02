//! Operator commands share the server binary so they reuse its config loading
//! and migrations, and `docker compose exec backend api user ...` works unchanged.

use std::io::{self, BufRead, IsTerminal, Write};

use clap::{Parser, Subcommand};
use secrecy::SecretString;

use crate::auth::password::{PasswordError, PasswordService};
use crate::clock::format_utc;
use crate::db::Db;
use crate::users::{self, normalize_email, UserError};

#[derive(Debug, Parser)]
#[command(
    name = "api",
    about = "Songbird API server; run without a command to serve"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    #[command(about = "Manage user accounts", subcommand)]
    User(UserCommand),
}

/// Passwords are deliberately not arguments: argv is visible to other local
/// users and lands in shell history.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum UserCommand {
    #[command(about = "Create an account; the password comes from the terminal or one stdin line")]
    Create { email: String },
    #[command(
        about = "Set a new password and end all of the account's sessions",
        name = "set-password"
    )]
    SetPassword { email: String },
    #[command(about = "Disable an account and end all of its sessions")]
    Disable { email: String },
    #[command(about = "Re-enable a disabled account")]
    Enable { email: String },
    #[command(about = "Delete an account with all of its projects, sessions, and usage")]
    Delete {
        email: String,
        #[arg(long, help = "Skip the retype prompt; required when not on a terminal")]
        yes: bool,
    },
    #[command(about = "List accounts")]
    List,
}

impl UserCommand {
    pub fn needs_password(&self) -> bool {
        matches!(self, Self::Create { .. } | Self::SetPassword { .. })
    }

    pub fn needs_retyped_email(&self) -> bool {
        matches!(self, Self::Delete { yes: false, .. })
    }
}

/// Gathered by the caller so the command logic stays testable without a terminal.
#[derive(Default)]
pub struct Inputs {
    pub password: Option<SecretString>,
    pub retyped_email: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error(transparent)]
    Password(#[from] PasswordError),
    #[error(transparent)]
    User(#[from] UserError),
    #[error("A password is required.")]
    PasswordRequired,
    #[error("The passwords did not match.")]
    PasswordsDiffer,
    #[error("Not deleted: retype the account's email to confirm on a terminal, or pass --yes.")]
    NotConfirmed,
    #[error("Could not read input: {0}")]
    Io(#[from] io::Error),
}

pub async fn run_user_command(
    db: &Db,
    passwords: &PasswordService,
    command: UserCommand,
    inputs: Inputs,
) -> Result<String, CliError> {
    match command {
        UserCommand::Create { email } => {
            let hash = passwords.hash(&required(inputs.password)?).await?;
            let user = users::create(db, &email, &hash).await?;
            Ok(format!("Created {}.", user.email))
        }
        UserCommand::SetPassword { email } => {
            let hash = passwords.hash(&required(inputs.password)?).await?;
            users::set_password(db, &email, &hash).await?;
            Ok(format!(
                "Password updated for {}; all of their sessions were ended.",
                normalize_email(&email)?
            ))
        }
        UserCommand::Disable { email } => {
            users::set_disabled(db, &email, true).await?;
            Ok(format!(
                "Disabled {}; all of their sessions were ended.",
                normalize_email(&email)?
            ))
        }
        UserCommand::Enable { email } => {
            users::set_disabled(db, &email, false).await?;
            Ok(format!("Enabled {}.", normalize_email(&email)?))
        }
        UserCommand::Delete { email, yes } => {
            let normalized = normalize_email(&email)?;
            let confirmed = yes
                || inputs
                    .retyped_email
                    .as_deref()
                    .and_then(|typed| normalize_email(typed).ok())
                    .is_some_and(|typed| typed == normalized);
            if !confirmed {
                return Err(CliError::NotConfirmed);
            }
            users::delete(db, &normalized).await?;
            Ok(format!("Deleted {normalized} and all of their data."))
        }
        UserCommand::List => {
            let all = users::list(db).await?;
            if all.is_empty() {
                return Ok("No users.".to_string());
            }
            Ok(all
                .iter()
                .map(|u| {
                    format!(
                        "{}\t{}\t{}",
                        u.email,
                        if u.disabled { "disabled" } else { "active" },
                        format_utc(u.created_at)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
    }
}

fn required(password: Option<SecretString>) -> Result<SecretString, CliError> {
    password.ok_or(CliError::PasswordRequired)
}

/// A terminal gets a hidden, confirmed prompt; anything else gets one stdin
/// line, which is how scripts and e2e setup supply a password without argv.
pub fn read_inputs(command: &UserCommand) -> Result<Inputs, CliError> {
    let interactive = io::stdin().is_terminal();
    let mut inputs = Inputs::default();
    if command.needs_password() {
        inputs.password = Some(if interactive {
            let first = rpassword::prompt_password("Password: ")?;
            let again = rpassword::prompt_password("Repeat password: ")?;
            if first != again {
                return Err(CliError::PasswordsDiffer);
            }
            SecretString::from(first)
        } else {
            SecretString::from(read_stdin_line()?)
        });
    }
    if command.needs_retyped_email() && interactive {
        eprint!("Retype the account's email to delete it and all of its data: ");
        io::stderr().flush()?;
        inputs.retyped_email = Some(read_stdin_line()?);
    }
    Ok(inputs)
}

fn read_stdin_line() -> Result<String, CliError> {
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}
