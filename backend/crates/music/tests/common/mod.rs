#![allow(dead_code)]

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use music::{GenerateRequest, GenerateRequestBody, InstrumentRegistry};

pub fn request(prompt: &str, measures: i64) -> GenerateRequest {
    request_for("drums", prompt, measures)
}

pub fn request_for(instrument: &str, prompt: &str, measures: i64) -> GenerateRequest {
    GenerateRequestBody {
        instrument: instrument.into(),
        prompt: prompt.into(),
        measures,
        ..Default::default()
    }
    .validate(&InstrumentRegistry::builtin(), 256)
    .unwrap()
}

/// Each test gets its own directory because the script reads its mode and
/// writes its logs beside itself, so sharing one would make parallel tests
/// interfere.
pub struct FakeCodex {
    pub dir: tempfile::TempDir,
}

impl FakeCodex {
    pub fn new(mode: &str, response: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_codex.sh");
        symlink(script, dir.path().join("codex")).unwrap();
        std::fs::write(dir.path().join("mode"), mode).unwrap();
        std::fs::write(dir.path().join("response.json"), response).unwrap();
        Self { dir }
    }

    pub fn bin(&self) -> PathBuf {
        self.dir.path().join("codex")
    }

    pub fn args_log(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("args.log")).unwrap_or_default()
    }

    pub fn stdin_log(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("stdin.log")).unwrap_or_default()
    }

    pub fn overlapped(&self) -> bool {
        self.dir.path().join("overlap").exists()
    }
}

/// One draft exercising every normalization rule at once: an out-of-range
/// velocity, a duplicate note, an unknown lane, and an alias.
pub const BAD_DRAFT: &str = r#"{
  "name": "  Messy   Draft  ", "tempo_bpm": 999, "swing": 3,
  "sections": [{"id": "A", "lanes": [
    {"lane": "kick", "steps": [200, 0, 0, 0]},
    {"lane": "bd", "steps": "x..."},
    {"lane": "cowbell", "steps": "xxxx"},
    {"lane": "hh", "steps": "x-x."}
  ]}],
  "arrangement": ["A"]
}"#;

pub const BAD_PIANO_DRAFT: &str = r#"{
  "name": "Messy Keys", "tempo_bpm": 90, "swing": 0,
  "sections": [{"id": "A", "lanes": [
    {"lane": "C4", "steps": [200, 0, 0, 0]},
    {"lane": "60", "steps": "x..."},
    {"lane": "E8", "steps": "x---"},
    {"lane": "Bb3", "steps": "..x-"},
    {"lane": "kick", "steps": "xxxx"}
  ]}],
  "arrangement": ["A"]
}"#;
