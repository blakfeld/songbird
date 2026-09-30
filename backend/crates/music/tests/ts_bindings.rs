//! The frontend imports these generated files directly, so a Rust change that
//! is not regenerated would silently break the API contract. Run
//! `just gen-types` to regenerate after changing an exported type.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use music::instruments::{InstrumentKind, PitchRange};
use music::{GenerateRequestBody, GenerationLimits, InstrumentInfo, Pattern};
use ts_rs::{Config, TS};

fn committed_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../frontend/src/generated")
}

fn export_into(dir: &Path) {
    let cfg = Config::new().with_out_dir(dir);
    Pattern::export_all(&cfg).unwrap();
    InstrumentInfo::export_all(&cfg).unwrap();
    InstrumentKind::export_all(&cfg).unwrap();
    PitchRange::export_all(&cfg).unwrap();
    GenerateRequestBody::export_all(&cfg).unwrap();
    GenerationLimits::export_all(&cfg).unwrap();
}

fn read_ts_files(dir: &Path) -> BTreeMap<String, String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .map(|e| e.unwrap().path())
                .filter(|p| p.extension().is_some_and(|ext| ext == "ts"))
                .map(|p| {
                    (
                        p.file_name().unwrap().to_string_lossy().into_owned(),
                        fs::read_to_string(&p).unwrap(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn generated_typescript_is_up_to_date() {
    let fresh = tempfile::tempdir().unwrap();
    export_into(fresh.path());
    let expected = read_ts_files(fresh.path());

    if std::env::var_os("UPDATE_TS_BINDINGS").is_some() {
        let dir = committed_dir();
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for (name, contents) in &expected {
            fs::write(dir.join(name), contents).unwrap();
        }
        return;
    }

    assert_eq!(
        read_ts_files(&committed_dir()),
        expected,
        "frontend/src/generated is stale; run `just gen-types`"
    );
}
