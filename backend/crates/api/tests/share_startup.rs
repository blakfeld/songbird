//! Lives in its own test binary: tracing caches per-callsite interest
//! process-wide, so capturing logs alongside other tests is order-dependent.

use std::io::Write;
use std::sync::{Arc, Mutex};

use api::config::{Config, DATABASE_URL, MASTER_KEYS, TRUST_PROXY};
use api::startup::build_state;

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

const KEY: &str = "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async fn startup_logs(trust_proxy: &str) -> String {
    let logs = LogBuffer::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}?mode=rwc", dir.path().join("t.db").display());
    let config = Config::from_lookup(|name| match name {
        MASTER_KEYS => Some(KEY.into()),
        DATABASE_URL => Some(url.clone()),
        TRUST_PROXY => Some(trust_proxy.into()),
        _ => None,
    })
    .unwrap();
    build_state(config).await.unwrap();

    let output = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    output
}

#[tokio::test]
async fn production_without_a_trusted_proxy_warns_that_listeners_share_one_bucket() {
    let output = startup_logs("false").await;

    let line = output
        .lines()
        .find(|l| l.contains("share-link listener"))
        .unwrap_or_else(|| panic!("no warning in {output}"));
    assert!(line.contains("WARN"), "{line}");
    assert!(line.contains(TRUST_PROXY), "{line}");
}

#[tokio::test]
async fn a_trusted_proxy_in_production_starts_without_that_warning() {
    let output = startup_logs("true").await;

    assert!(!output.contains("share-link listener"), "{output}");
}
