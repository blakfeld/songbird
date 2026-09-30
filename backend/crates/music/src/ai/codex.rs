use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Semaphore;

use super::{ProviderError, StructuredProvider, StructuredRequest};

const DEFAULT_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// The npm `codex` launcher spawns a native child, so killing only the direct
/// child would orphan the process that actually spends plan quota; the whole
/// process group is killed instead.
struct ProcessGroupKill(Option<u32>);

impl ProcessGroupKill {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for ProcessGroupKill {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // SAFETY: plain syscall with integer arguments; a stale pgid only
            // yields ESRCH.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

/// Runs the operator's signed-in Codex CLI so a ChatGPT plan can be used for
/// quality checks. Local testing only: it spends a personal subscription.
pub struct CodexCliProvider {
    bin: PathBuf,
    model: Option<String>,
    /// Serialized so plan usage limits are not burned by parallel runs.
    single_run: Semaphore,
    check_timeout: Duration,
}

impl CodexCliProvider {
    pub fn new(bin: impl Into<PathBuf>, model: Option<String>) -> Self {
        Self {
            bin: bin.into(),
            model,
            single_run: Semaphore::new(1),
            check_timeout: DEFAULT_CHECK_TIMEOUT,
        }
    }

    /// Startup must not hang forever on a wedged CLI; tests shorten this.
    pub fn with_check_timeout(mut self, timeout: Duration) -> Self {
        self.check_timeout = timeout;
        self
    }

    /// Everything except the working directory and file paths, which are
    /// per-run; kept separate so tests can assert the exact flags.
    fn exec_args(&self, dir: &Path, schema: &Path, output: &Path) -> Vec<String> {
        let mut args: Vec<String> = [
            "exec",
            // The working directory is a fresh temp dir, not a repository.
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--color",
            "never",
            "--output-schema",
        ]
        .map(String::from)
        .to_vec();
        args.push(schema.display().to_string());
        args.push("--output-last-message".into());
        args.push(output.display().to_string());
        args.push("-C".into());
        args.push(dir.display().to_string());
        if let Some(model) = &self.model {
            args.push("-m".into());
            args.push(model.clone());
        }
        args.push("-".into());
        args
    }
}

#[async_trait]
impl StructuredProvider for CodexCliProvider {
    fn name(&self) -> &'static str {
        "codex"
    }

    async fn generate(&self, request: &StructuredRequest) -> Result<Value, ProviderError> {
        let _permit = self
            .single_run
            .acquire()
            .await
            .map_err(|_| ProviderError::Request("codex runner is shut down".into()))?;

        let io = |what: &str, e: std::io::Error| {
            ProviderError::Request(format!("could not {what}: {e}"))
        };
        let dir = tempfile::tempdir().map_err(|e| io("create a temp directory", e))?;
        let schema_path = dir.path().join("schema.json");
        let output_path = dir.path().join("last_message.json");
        tokio::fs::write(&schema_path, request.schema.to_string())
            .await
            .map_err(|e| io("write the output schema", e))?;

        let mut command = Command::new(&self.bin);
        command
            .args(self.exec_args(dir.path(), &schema_path, &output_path))
            .current_dir(dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            // Dropping this future (the generation timeout) must not leave an
            // agent process spending plan quota.
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|e| io("start the codex CLI", e))?;
        let mut group_kill = ProcessGroupKill(child.id());

        let prompt = format!("{}\n\n{}", request.system, request.user);
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let mut stderr = child.stderr.take().expect("stderr was piped");
        // Written concurrently with reading stderr so a full pipe cannot deadlock the child.
        let write_prompt = async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            drop(stdin);
        };
        let read_stderr = async move {
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut buf).await;
            buf
        };
        let (_, stderr_bytes, status) = tokio::join!(write_prompt, read_stderr, child.wait());
        let status = status.map_err(|e| io("wait for the codex CLI", e))?;
        group_kill.disarm();
        if !status.success() {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&stderr_bytes).chars().take(500).collect::<String>(),
                "codex exec failed"
            );
            return Err(ProviderError::Request(format!(
                "the codex CLI exited with {status}"
            )));
        }

        let text = tokio::fs::read_to_string(&output_path)
            .await
            .map_err(|e| ProviderError::InvalidOutput(format!("no final message written: {e}")))?;
        serde_json::from_str(&text)
            .map_err(|e| ProviderError::InvalidOutput(format!("final message is not JSON: {e}")))
    }

    async fn check(&self) -> Result<(), ProviderError> {
        let bin = self.bin.display();
        let run = Command::new(&self.bin)
            .args(["login", "status"])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        let output = tokio::time::timeout(self.check_timeout, run)
            .await
            .map_err(|_| {
                ProviderError::Unavailable(format!(
                    "The Codex CLI ({bin}) did not answer `login status` within {} seconds.",
                    self.check_timeout.as_secs_f32()
                ))
            })?
            .map_err(|_| {
                ProviderError::Unavailable(format!(
                    "The Codex CLI ({bin}) was not found. Install it (`npm i -g @openai/codex` or `brew install codex`) or set SONGBIRD_CODEX_BIN."
                ))
            })?;
        if output.status.success() {
            Ok(())
        } else {
            Err(ProviderError::Unavailable(
                "The Codex CLI is not signed in. Run `codex login` and choose ChatGPT.".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_args_are_exactly_the_documented_flags() {
        let p = CodexCliProvider::new("codex", Some("gpt-x".into()));
        let args = p.exec_args(
            Path::new("/w"),
            Path::new("/w/s.json"),
            Path::new("/w/o.json"),
        );
        assert_eq!(
            args,
            [
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--color",
                "never",
                "--output-schema",
                "/w/s.json",
                "--output-last-message",
                "/w/o.json",
                "-C",
                "/w",
                "-m",
                "gpt-x",
                "-"
            ]
        );
    }

    #[test]
    fn model_flag_is_omitted_when_unset() {
        let p = CodexCliProvider::new("codex", None);
        let args = p.exec_args(Path::new("/w"), Path::new("/s"), Path::new("/o"));
        assert!(!args.contains(&"-m".to_string()));
    }
}
