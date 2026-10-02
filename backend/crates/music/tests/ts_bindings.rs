//! The frontend imports these generated files directly, so a Rust change that
//! is not regenerated would silently break the API contract. Run
//! `just gen-types` to regenerate after changing an exported type.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use music::chat::{ChatBody, ChatMessage, ChatResponse, ChatTrack};
use music::instruments::{InstrumentKind, PitchRange};
use music::song::{
    AudioClip, ChatEntry, ChatRole, ChorusEffect, DelayEffect, DistortionEffect, Effects, EqEffect,
    KeyMode, KeysSettings, LoopRegion, MeasureRegion, PadSettings, ReverbEffect, Sample,
    SamplerSettings, SongKey, Tone, Tonic, TrackSound,
};
use music::track_generation::{MeasureRange, SongLimits, TrackGenerateBody, TrackGenerateResponse};
use music::{
    Clip, GenerateRequestBody, GenerationLimits, InstrumentInfo, InstrumentRegistry, Loop, Pattern,
    Song, Track,
};
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
    Song::export_all(&cfg).unwrap();
    Track::export_all(&cfg).unwrap();
    Loop::export_all(&cfg).unwrap();
    Clip::export_all(&cfg).unwrap();
    Sample::export_all(&cfg).unwrap();
    AudioClip::export_all(&cfg).unwrap();
    SamplerSettings::export_all(&cfg).unwrap();
    KeysSettings::export_all(&cfg).unwrap();
    PadSettings::export_all(&cfg).unwrap();
    SongKey::export_all(&cfg).unwrap();
    Tonic::export_all(&cfg).unwrap();
    KeyMode::export_all(&cfg).unwrap();
    LoopRegion::export_all(&cfg).unwrap();
    MeasureRegion::export_all(&cfg).unwrap();
    MeasureRange::export_all(&cfg).unwrap();
    TrackGenerateBody::export_all(&cfg).unwrap();
    TrackGenerateResponse::export_all(&cfg).unwrap();
    SongLimits::export_all(&cfg).unwrap();
    ChatBody::export_all(&cfg).unwrap();
    ChatMessage::export_all(&cfg).unwrap();
    ChatResponse::export_all(&cfg).unwrap();
    ChatTrack::export_all(&cfg).unwrap();
    ChatRole::export_all(&cfg).unwrap();
    ChatEntry::export_all(&cfg).unwrap();
    TrackSound::export_all(&cfg).unwrap();
    Tone::export_all(&cfg).unwrap();
    Effects::export_all(&cfg).unwrap();
    EqEffect::export_all(&cfg).unwrap();
    DistortionEffect::export_all(&cfg).unwrap();
    ChorusEffect::export_all(&cfg).unwrap();
    DelayEffect::export_all(&cfg).unwrap();
    ReverbEffect::export_all(&cfg).unwrap();
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

fn instruments_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/instruments.json")
}

/// The browser's song validation tests run against the real registry rather
/// than a stub, so this snapshot must track `GET /api/v1/instruments`.
#[test]
fn instruments_fixture_is_up_to_date() {
    let actual =
        serde_json::to_string_pretty(&InstrumentRegistry::builtin().infos()).unwrap() + "\n";
    if std::env::var_os("UPDATE_TS_BINDINGS").is_some() {
        fs::write(instruments_fixture(), &actual).unwrap();
        return;
    }
    assert_eq!(
        fs::read_to_string(instruments_fixture()).unwrap_or_default(),
        actual,
        "fixtures/instruments.json is stale; run `just gen-types`"
    );
}
