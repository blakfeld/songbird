//! Operator commands share the server binary so they reuse its config loading
//! and migrations, and `docker compose exec backend api user ...` works unchanged.

use std::io::{self, BufRead, IsTerminal, Write};

use clap::{Parser, Subcommand};
use secrecy::SecretString;

use crate::auth::password::{PasswordError, PasswordService};
use crate::clock::format_utc;
use crate::config::Keyring;
use crate::db::Db;
use crate::keys::{self, KeyStoreError};
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
    #[command(
        about = "Manage the master keys that protect users' stored AI keys",
        subcommand
    )]
    Keys(KeysCommand),
}

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum KeysCommand {
    #[command(
        about = "Print a fresh SONGBIRD_MASTER_KEYS entry; put it first in the list to start using it",
        name = "generate-master-key"
    )]
    GenerateMasterKey,
    #[command(about = "Re-encrypt every stored key under the current master key")]
    Rotate,
    #[command(about = "Delete the stored keys of a master key version that has been lost")]
    Purge {
        #[arg(long, help = "The master key version whose keys are deleted")]
        version: String,
        #[arg(long, help = "Skip the retype prompt; required when not on a terminal")]
        yes: bool,
    },
}

impl KeysCommand {
    pub fn needs_database(&self) -> bool {
        !matches!(self, Self::GenerateMasterKey)
    }
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
    #[error(transparent)]
    KeyStore(#[from] KeyStoreError),
    #[error("{0}")]
    Keyring(String),
    #[error("Nothing was deleted: retype the version to confirm on a terminal, or pass --yes.")]
    PurgeNotConfirmed,
    #[error(
        "Master key version {0} is still in SONGBIRD_MASTER_KEYS, so the keys sealed under it are readable and were not deleted. Run `api keys rotate` to move them to the current key. If the key is really lost, remove that version from SONGBIRD_MASTER_KEYS and run purge again."
    )]
    VersionStillInKeyring(String),
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

/// The next number after the highest `v<digits>` in the current keyring, so that prepending
/// the printed entry makes it the new encrypting key without clashing with an existing version.
pub fn generate_master_key(current: Option<&Keyring>) -> String {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use chacha20poly1305::aead::OsRng;
    use chacha20poly1305::{KeyInit, XChaCha20Poly1305};

    let next = current
        .into_iter()
        .flat_map(|ring| ring.versions())
        .filter_map(|v| v.strip_prefix('v')?.parse::<u64>().ok())
        .max()
        .map_or(1, |highest| highest + 1);
    let key = XChaCha20Poly1305::generate_key(&mut OsRng);
    format!("v{next}:{}", BASE64.encode(key))
}

pub async fn rotate_keys(db: &Db, keyring: &Keyring) -> Result<String, CliError> {
    let report = keys::rotate(db, keyring).await?;
    let current = keyring.current().0;
    let remaining = keys::count_not_on_version(db, current).await?;
    let verdict = if remaining == 0 {
        format!(
            "No keys remain on older versions, so they can be dropped from {}.",
            crate::config::MASTER_KEYS
        )
    } else {
        format!(
            "{remaining} keys are still on older versions; keep those versions in {} until they are resolved.",
            crate::config::MASTER_KEYS
        )
    };
    Ok(format!(
        "Re-encrypted {} keys under {current}; {} already on {current}; {} could not be decrypted (left unchanged).\n{verdict}",
        report.rewritten, report.already_current, report.undecryptable
    ))
}

/// Refuses a version the keyring still holds, because those keys are readable and deleting
/// them would destroy working data; only a version proven absent can be a lost one. Retyping
/// the version is the terminal confirmation since the deletion cannot be undone.
pub async fn purge_keys(
    db: &Db,
    keyring: &Keyring,
    version: &str,
    yes: bool,
    retyped_version: Option<&str>,
) -> Result<String, CliError> {
    // A typo should not read as success.
    if purge_preflight(db, keyring, version).await? == 0 {
        return Ok(format!(
            "No stored keys use version {version}; nothing was deleted."
        ));
    }
    if !yes && retyped_version != Some(version) {
        return Err(CliError::PurgeNotConfirmed);
    }
    let deleted = keys::purge_version(db, version).await?;
    Ok(format!(
        "Deleted {deleted} stored keys encrypted under master key version {version}."
    ))
}

/// Everything that can refuse a purge, so the operator is never asked to confirm one that will
/// be refused or that deletes nothing. Returns how many rows a purge would delete.
pub async fn purge_preflight(db: &Db, keyring: &Keyring, version: &str) -> Result<u64, CliError> {
    if keyring.get(version).is_some() {
        return Err(CliError::VersionStillInKeyring(version.to_string()));
    }
    Ok(keys::count_with_version(db, version).await?)
}

/// Shows the row count in the prompt so the operator confirms the real consequence.
pub fn read_retyped_version(version: &str, rows: u64) -> Result<Option<String>, CliError> {
    if !io::stdin().is_terminal() {
        return Ok(None);
    }
    eprint!(
        "This deletes {rows} stored keys sealed under {version}. Retype the version to confirm: "
    );
    io::stderr().flush()?;
    Ok(Some(read_stdin_line()?))
}

pub fn keyring_required(keyring: Option<Keyring>) -> Result<Keyring, CliError> {
    keyring.ok_or_else(|| {
        CliError::Keyring(format!(
            "{} is required for this command",
            crate::config::MASTER_KEYS
        ))
    })
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
