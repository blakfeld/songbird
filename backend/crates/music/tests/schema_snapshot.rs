use music::ai::prompt::draft_schema;
use music::instruments::drums::DRUMS;
use music::instruments::piano::PIANO;
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
