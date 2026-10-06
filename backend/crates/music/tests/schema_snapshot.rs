use music::ai::prompt::draft_schema;
use music::instruments::bass::BASS;
use music::instruments::drums::DRUMS;
use music::instruments::electric_piano::ELECTRIC_PIANO;
use music::instruments::organ::ORGAN;
use music::instruments::piano::PIANO;
use music::instruments::pluck::PLUCK;
use music::instruments::strings::STRINGS;
use music::instruments::synth_lead::SYNTH_LEAD;
use music::instruments::synth_pad::SYNTH_PAD;
use music::Instrument;

fn check_snapshot(instrument: &Instrument, file: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots")
        .join(file);
    let actual = serde_json::to_string_pretty(&draft_schema(instrument)).unwrap() + "\n";
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).expect("snapshot exists; see test docs");
    assert_eq!(actual, expected, "{file} changed");
}

/// Providers are told to emit exactly this schema, so any change to it is a
/// change to the prompt contract and must be reviewed as one.
/// Regenerate with `UPDATE_SNAPSHOTS=1 cargo test -p music --test schema_snapshot`.
#[test]
fn drums_draft_schema_matches_snapshot() {
    check_snapshot(&DRUMS, "drums_draft_schema.json");
}

#[test]
fn piano_draft_schema_matches_snapshot() {
    check_snapshot(&PIANO, "piano_draft_schema.json");
    let schema = draft_schema(&PIANO);
    let lanes = schema["$defs"]["DraftLane"]["properties"]["lane"]["enum"]
        .as_array()
        .unwrap();
    assert_eq!(lanes.len(), 61);
    assert_eq!(lanes[0], "C7");
    assert_eq!(lanes[60], "C2");
}

#[test]
fn electric_piano_draft_schema_matches_snapshot() {
    check_snapshot(&ELECTRIC_PIANO, "electric_piano_draft_schema.json");
}

#[test]
fn organ_draft_schema_matches_snapshot() {
    check_snapshot(&ORGAN, "organ_draft_schema.json");
}

#[test]
fn bass_draft_schema_matches_snapshot() {
    check_snapshot(&BASS, "bass_draft_schema.json");
}

#[test]
fn synth_lead_draft_schema_matches_snapshot() {
    check_snapshot(&SYNTH_LEAD, "synth_lead_draft_schema.json");
}

#[test]
fn synth_pad_draft_schema_matches_snapshot() {
    check_snapshot(&SYNTH_PAD, "synth_pad_draft_schema.json");
}

#[test]
fn strings_draft_schema_matches_snapshot() {
    check_snapshot(&STRINGS, "strings_draft_schema.json");
}

#[test]
fn pluck_draft_schema_matches_snapshot() {
    check_snapshot(&PLUCK, "pluck_draft_schema.json");
}

fn lyrics_ids() -> Vec<String> {
    vec!["verse-1".to_string(), "chorus-1".to_string()]
}

#[test]
fn lyrics_schema_matches_snapshot() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots/lyrics_schema.json");
    let schema = music::ai::lyrics::lyrics_schema(&lyrics_ids());
    let actual = serde_json::to_string_pretty(&schema).unwrap() + "\n";
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).expect("snapshot exists; see test docs");
    assert_eq!(actual, expected, "lyrics_schema.json changed");
}

#[test]
fn lyrics_schema_section_id_enum_is_the_request_ids() {
    let schema = music::ai::lyrics::lyrics_schema(&lyrics_ids());
    assert_eq!(
        schema["$defs"]["DraftSuggestion"]["properties"]["section_id"]["enum"],
        serde_json::json!(["verse-1", "chorus-1", null])
    );
}

#[test]
fn vocal_draft_schema_matches_snapshot() {
    check_snapshot(&music::instruments::vocal::VOCAL, "vocal_draft_schema.json");
}

#[test]
fn topline_schema_matches_snapshot() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots/topline_schema.json");
    let actual =
        serde_json::to_string_pretty(&music::ai::topline::topline_schema()).unwrap() + "\n";
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).expect("snapshot exists; see test docs");
    assert_eq!(actual, expected, "topline_schema.json changed");
}
