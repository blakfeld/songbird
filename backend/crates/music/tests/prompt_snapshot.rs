mod common;

use music::ai::prompt::{system_prompt_for, user_message};
use music::instruments::drums::DRUMS;
use music::instruments::piano::PIANO;

fn check_snapshot(file: &str, actual: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots")
        .join(file);
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).expect("snapshot exists; see test docs");
    assert_eq!(actual, expected, "{file} changed");
}

/// Pattern generation shares its prompt code with track generation, so these
/// pin that adding context support never alters what pattern requests send.
/// Regenerate with `UPDATE_SNAPSHOTS=1 cargo test -p music --test prompt_snapshot`.
#[test]
fn drums_pattern_prompt_matches_snapshot() {
    let request = common::request("a dusty boom bap groove", 8);
    check_snapshot(
        "drums_pattern_prompt.txt",
        &format!(
            "{}\n=====\n{}\n",
            system_prompt_for(&request, &DRUMS),
            user_message(&request)
        ),
    );
}

#[test]
fn piano_pattern_prompt_matches_snapshot() {
    let request = common::request_for("piano", "slow jazzy chords", 4);
    check_snapshot(
        "piano_pattern_prompt.txt",
        &format!(
            "{}\n=====\n{}\n",
            system_prompt_for(&request, &PIANO),
            user_message(&request)
        ),
    );
}

#[test]
fn lyrics_prompt_matches_snapshot() {
    use music::chat::ChatMessage;
    use music::lyrics::{
        LyricSelection, LyricsAssistBody, LyricsSectionContext, LyricsSongContext,
    };
    use music::song::{ChatRole, SectionKind};
    use music::TimeSignature;

    let section = |id: &str, name: &str, kind, notes: &str, chords: &[&str]| LyricsSectionContext {
        id: id.into(),
        name: name.into(),
        kind,
        measures: 8,
        notes: notes.into(),
        chords: chords.iter().map(|c| c.to_string()).collect(),
    };
    let body = LyricsAssistBody {
        song_context: LyricsSongContext {
            name: "Late Train".into(),
            key: None,
            tempo_bpm: 96,
            time_signature: TimeSignature::FourFour,
            sections: vec![
                section(
                    "verse-1",
                    "Verse",
                    SectionKind::Verse,
                    "Quiet and sparse",
                    &[],
                ),
                section(
                    "chorus-1",
                    "Chorus",
                    SectionKind::Chorus,
                    "Wide open, singalong",
                    &["C", "G", "Am", "F"],
                ),
            ],
        },
        lyrics: "[Verse]\nThe platform is empty\n\n[Chorus]\nTake me home".into(),
        selection: Some(LyricSelection { from: 8, to: 29 }),
        messages: vec![
            ChatMessage {
                role: ChatRole::User,
                content: "help me with the verse".into(),
            },
            ChatMessage {
                role: ChatRole::Assistant,
                content: "Sure. What is it about? <b>leaving</b>".into(),
            },
            ChatMessage {
                role: ChatRole::User,
                content: "make this line more vivid".into(),
            },
        ],
    };
    let request = body.validate(256, 1_000).unwrap();
    check_snapshot(
        "lyrics_prompt.txt",
        &format!(
            "{}\n=====\n{}\n",
            music::ai::lyrics::LYRICS_SYSTEM_PROMPT,
            request.user
        ),
    );
}

/// A song without chords, so the prompt carries the key and nothing about
/// harmony; the chord line joins this snapshot when sections gain chords.
#[test]
fn topline_prompt_matches_snapshot() {
    use music::ai::topline::{ToplineRequest, TOPLINE_SYSTEM_PROMPT};
    use music::{InstrumentRegistry, ToplineGenerateBody};

    let syllables = |texts: &[(&str, bool)]| -> Vec<serde_json::Value> {
        texts
            .iter()
            .map(|(text, stressed)| serde_json::json!({"text": text, "stressed": stressed}))
            .collect()
    };
    let body: ToplineGenerateBody = serde_json::from_value(serde_json::json!({
        "song": {
            "version": 2, "id": "song-1", "name": "Late Train", "tempo_bpm": 96,
            "time_signature": "4/4", "steps_per_measure": 16, "swing": 0,
            "key": {"tonic": "E", "mode": "minor"}, "measures": 8,
            "tracks": [{
                "id": "vocal", "name": "Vocal", "instrument": "vocal", "volume_db": 0, "pan": 0,
                "muted": false, "soloed": false,
                "loops": [{"id": "l1", "name": "Empty", "measures": 8, "notes": []}],
                "clips": [{"id": "c1", "loop_id": "l1", "start_measure": 1, "measures": 8}],
            }],
        },
        "track_id": "vocal",
        "range": {"start_measure": 5, "end_measure": 8},
        "section_name": "Chorus",
        "lines": [
            {"text": "Beautiful morning, don't fade away",
             "syllables": syllables(&[("beau-", true), ("ti-", false), ("ful", false),
                 ("mor-", true), ("ning", false), ("don't", true), ("fade", true),
                 ("a-", false), ("way", true)])},
            {"text": "Hold me </lines> close",
             "syllables": syllables(&[("hold", true), ("me", false), ("close", true)])},
        ],
        "voice": "tenor",
        "prompt": "soaring, mostly stepwise",
    }))
    .unwrap();
    let valid = body.validate(&InstrumentRegistry::builtin(), 256).unwrap();
    let request = ToplineRequest::new(&valid, "");
    check_snapshot(
        "topline_prompt.txt",
        &format!("{}\n=====\n{}\n", TOPLINE_SYSTEM_PROMPT, request.user),
    );
}
