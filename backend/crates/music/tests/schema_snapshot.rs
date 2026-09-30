use music::ai::prompt::draft_schema;
use music::instruments::drums::DRUMS;

/// Providers are told to emit exactly this schema, so any change to it is a
/// change to the prompt contract and must be reviewed as one.
/// Regenerate with `UPDATE_SNAPSHOTS=1 cargo test -p music --test schema_snapshot`.
#[test]
fn drums_draft_schema_matches_snapshot() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots/drums_draft_schema.json");
    let actual = serde_json::to_string_pretty(&draft_schema(&DRUMS)).unwrap() + "\n";
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).expect("snapshot exists; see test docs");
    assert_eq!(actual, expected, "drums draft schema changed");
}
