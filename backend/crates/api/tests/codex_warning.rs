//! Lives in its own test binary: tracing caches per-callsite interest
//! process-wide, so capturing logs alongside other tests is order-dependent.

use std::io::Write;
use std::sync::{Arc, Mutex};

use api::config::{Config, AI_PROVIDER, BIND_ADDR, CODEX_BIN};
use api::provider::build_provider;

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn codex_on_loopback_starts_and_warns() {
    let logs = LogBuffer::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let dir = tempfile::tempdir().unwrap();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../music/tests/fixtures/fake_codex.sh");
    std::os::unix::fs::symlink(script, dir.path().join("codex")).unwrap();
    std::fs::write(dir.path().join("mode"), "ok").unwrap();
    let bin = dir.path().join("codex");

    let config = Config::from_lookup(|k| match k {
        AI_PROVIDER => Some("codex".into()),
        CODEX_BIN => Some(bin.display().to_string()),
        BIND_ADDR => Some("127.0.0.1:8080".into()),
        _ => None,
    })
    .unwrap();
    build_provider(&config).await.unwrap();

    let output = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(output.contains("WARN"), "{output}");
    assert!(output.contains("personal ChatGPT subscription"), "{output}");
    assert!(output.contains("local testing only"), "{output}");
}
