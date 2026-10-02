mod common;

use std::sync::Arc;

use api::config::{Config, AI_PROVIDER};
use api::provider::Providers;
use api::routes::SONG_MAX_BODY_BYTES;
use api::state::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, Request, StatusCode};
use http_body_util::BodyExt;
use midly::Smf;
use music::InstrumentRegistry;
use serde_json::{json, Value};
use tower::ServiceExt;

const ALLOWED_ORIGIN: &str = "http://localhost:3000";
const EXPORT_URI: &str = "/api/v1/songs/export/midi";
const ONE_MIB: usize = 1024 * 1024;

async fn app() -> axum::Router {
    let db = common::db::test_db().await;
    let config = Config::from_lookup(|k| (k == AI_PROVIDER).then(|| "mock".to_string())).unwrap();
    let router = api::app(AppState {
        providers: Providers::mock(),
        instruments: InstrumentRegistry::builtin(),
        config: Arc::new(config),
        db: db.clone(),
    });
    db.keep_alive_with(router)
}

fn track(id: &str, name: &str, instrument: &str, loops: Value, clips: Value) -> Value {
    json!({
        "id": id, "name": name, "instrument": instrument, "volume_db": 0, "pan": 0,
        "muted": false, "soloed": false, "loops": loops, "clips": clips,
    })
}

fn song(measures: u32, tracks: Vec<Value>) -> Value {
    json!({
        "version": 2, "id": "song-1", "name": "Late Train", "tempo_bpm": 96,
        "time_signature": "4/4", "steps_per_measure": 16, "swing": 0,
        "measures": measures, "tracks": tracks,
    })
}

fn note(row: &str, step: u32) -> Value {
    json!({"row_id": row, "step": step, "length_steps": 1, "velocity": 100})
}

fn two_track_song() -> Value {
    song(
        4,
        vec![
            track(
                "t1",
                "Drums",
                "drums",
                json!([{"id": "l1", "name": "Beat", "measures": 1, "notes": [note("kick", 0)]}]),
                json!([{"id": "c1", "loop_id": "l1", "start_measure": 1, "measures": 4}]),
            ),
            track(
                "t2",
                "Bass",
                "bass",
                json!([{"id": "l2", "name": "Line", "measures": 1, "notes": [note("C2", 0)]}]),
                json!([{"id": "c2", "loop_id": "l2", "start_measure": 1, "measures": 4}]),
            ),
        ],
    )
}

/// The largest realistic song, used to check the body limit leaves room for it;
/// cycling rows keeps every note valid without overlaps.
fn dense_song(tracks: usize, stride: usize) -> Value {
    let rows = music::instruments::piano::PIANO.row_list();
    let notes: Vec<Value> = (0..128 * 16)
        .step_by(stride)
        .enumerate()
        .map(|(i, step)| note(&rows[i % rows.len()].id, step as u32))
        .collect();
    let tracks = (0..tracks)
        .map(|i| {
            track(
                &format!("t{i}"),
                &format!("Track {i}"),
                "piano",
                json!([{"id": format!("l{i}"), "name": "Loop", "measures": 128, "notes": notes}]),
                json!([{"id": format!("c{i}"), "loop_id": format!("l{i}"), "start_measure": 1, "measures": 128}]),
            )
        })
        .collect();
    song(128, tracks)
}

async fn post_export(
    app: axum::Router,
    body: String,
    origin: bool,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut req = Request::post(EXPORT_URI)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, body.len());
    if origin {
        req = req.header(header::ORIGIN, ALLOWED_ORIGIN);
    }
    let res = app
        .oneshot(req.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (parts, body) = res.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes().to_vec(),
    )
}

async fn export(song: &Value) -> (StatusCode, HeaderMap, Vec<u8>) {
    post_export(app().await, song.to_string(), false).await
}

fn error_of(bytes: &[u8]) -> Value {
    serde_json::from_slice::<Value>(bytes).unwrap()["error"].clone()
}

#[tokio::test]
async fn two_track_song_exports_a_named_midi_file() {
    let (status, headers, bytes) = export(&two_track_song()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "audio/midi");
    assert_eq!(
        headers.get(header::CONTENT_DISPOSITION).unwrap(),
        "attachment; filename=\"songbird-late-train-96bpm.mid\""
    );
    assert_eq!(Smf::parse(&bytes).unwrap().tracks.len(), 3);
}

#[tokio::test]
async fn empty_song_exports_only_the_conductor_track() {
    let (status, _, bytes) = export(&song(4, vec![])).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(Smf::parse(&bytes).unwrap().tracks.len(), 1);
}

#[tokio::test]
async fn unknown_row_names_the_track() {
    let mut s = two_track_song();
    s["tracks"][1]["loops"][0]["notes"] = json!([note("kick", 0)]);
    let (status, _, bytes) = export(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let error = error_of(&bytes);
    assert_eq!(error["code"], "invalid_song");
    assert!(error["message"].as_str().unwrap().contains("\"Bass\""));
}

#[tokio::test]
async fn unknown_instrument_is_invalid_instrument() {
    let mut s = two_track_song();
    s["tracks"][1]["instrument"] = json!("kazoo");
    let (status, _, bytes) = export(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let error = error_of(&bytes);
    assert_eq!(error["code"], "invalid_instrument");
    assert!(error["message"].as_str().unwrap().contains("\"Bass\""));
}

#[tokio::test]
async fn clip_naming_another_tracks_loop_is_invalid_song() {
    let mut s = two_track_song();
    s["tracks"][1]["clips"][0]["loop_id"] = json!("l1");
    let (status, _, bytes) = export(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let error = error_of(&bytes);
    assert_eq!(error["code"], "invalid_song");
    assert!(error["message"].as_str().unwrap().contains("\"Bass\""));
}

#[tokio::test]
async fn overlapping_clips_are_invalid_song() {
    let mut s = two_track_song();
    s["tracks"][0]["clips"] = json!([
        {"id": "c1", "loop_id": "l1", "start_measure": 1, "measures": 4},
        {"id": "c9", "loop_id": "l1", "start_measure": 3, "measures": 1},
    ]);
    let (status, _, bytes) = export(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_of(&bytes)["code"], "invalid_song");
}

#[tokio::test]
async fn unrecognised_song_fields_are_accepted() {
    let mut s = two_track_song();
    s["mood"] = json!("wistful");
    let (status, _, _) = export(&s).await;
    assert_eq!(status, StatusCode::OK);
}

/// The size estimate behind the song body limit: the densest song the track and
/// measure caps allow, with a note on every step, must still be accepted.
#[tokio::test]
async fn densest_sixteen_track_song_fits_the_song_body_limit() {
    let body = dense_song(16, 1).to_string();
    println!("dense 16x128 song: {} bytes", body.len());
    assert!(body.len() > ONE_MIB, "{} bytes", body.len());
    assert!(body.len() < SONG_MAX_BODY_BYTES, "{} bytes", body.len());
    let (status, _, bytes) = post_export(app().await, body, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(Smf::parse(&bytes).unwrap().tracks.len(), 17);
}

#[tokio::test]
async fn six_hundred_kib_song_is_accepted() {
    let mut body = dense_song(16, 2);
    let target = 600 * 1024;
    // Trimmed by dropping whole notes so the song stays valid while landing
    // near the size the spec names.
    while body.to_string().len() > target {
        for track in body["tracks"].as_array_mut().unwrap() {
            let notes = track["loops"][0]["notes"].as_array_mut().unwrap();
            let keep = notes.len() * 9 / 10;
            notes.truncate(keep.max(1));
        }
    }
    let body = body.to_string();
    assert!(body.len() > 400 * 1024, "{} bytes", body.len());
    let (status, _, _) = post_export(app().await, body, false).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn three_mebibyte_song_is_rejected_with_cors_headers() {
    let body = format!(r#"{{"pad":"{}"}}"#, "a".repeat(3 * ONE_MIB));
    let (status, headers, bytes) = post_export(app().await, body, true).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_of(&bytes)["code"], "payload_too_large");
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        ALLOWED_ORIGIN
    );
}

#[tokio::test]
async fn one_mebibyte_to_a_pattern_route_is_still_rejected() {
    let body = format!(r#"{{"pad":"{}"}}"#, "a".repeat(ONE_MIB));
    let req = Request::post("/api/v1/patterns/generate")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .unwrap();
    let res = app().await.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn midi_export_ignores_track_sound() {
    let plain = two_track_song();
    let mut shaped = two_track_song();
    shaped["tracks"][1]["sound"] = json!({
        "tone": {"filter_cutoff_hz": 400},
        "effects": {
            "distortion": {"enabled": true, "drive": 0.9},
            "reverb": {"enabled": true, "mix": 0.8},
        },
    });
    let (plain_status, _, plain_bytes) = export(&plain).await;
    let (shaped_status, _, shaped_bytes) = export(&shaped).await;
    assert_eq!(plain_status, StatusCode::OK);
    assert_eq!(shaped_status, StatusCode::OK);
    assert_eq!(plain_bytes, shaped_bytes);
}

#[tokio::test]
async fn out_of_range_sound_setting_names_the_track_and_setting() {
    let mut s = two_track_song();
    s["tracks"][1]["sound"] = json!({"effects": {"delay": {"feedback": 1.5}}});
    let (status, _, bytes) = export(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let error = error_of(&bytes);
    assert_eq!(error["code"], "invalid_song");
    let message = error["message"].as_str().unwrap();
    assert!(message.contains("\"Bass\""), "{message}");
    assert!(message.contains("feedback"), "{message}");
}

#[tokio::test]
async fn export_follows_track_array_order_for_names_and_channels() {
    let keys = || track("t1", "Keys", "piano", json!([]), json!([]));
    let bass = || track("t2", "Bass", "bass", json!([]), json!([]));

    // Raw MIDI channels are zero-based, so channel 1 is index 0.
    for (tracks, expected) in [
        (vec![keys(), bass()], [("Keys", 0), ("Bass", 1)]),
        (vec![bass(), keys()], [("Bass", 0), ("Keys", 1)]),
    ] {
        let (status, _, bytes) = export(&song(1, tracks)).await;
        assert_eq!(status, StatusCode::OK);
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(smf.tracks.len(), 3);
        for (track, (name, channel)) in smf.tracks[1..].iter().zip(expected) {
            let track_name = track.iter().find_map(|e| match e.kind {
                midly::TrackEventKind::Meta(midly::MetaMessage::TrackName(n)) => Some(n),
                _ => None,
            });
            assert_eq!(track_name, Some(name.as_bytes()));
            let channels: Vec<u8> = track
                .iter()
                .filter_map(|e| match e.kind {
                    midly::TrackEventKind::Midi { channel, .. } => Some(channel.as_int()),
                    _ => None,
                })
                .collect();
            assert!(!channels.is_empty() && channels.iter().all(|&c| c == channel));
        }
    }
}

fn audio_song_parts() -> (Value, Value) {
    let sample = json!({
        "id": "s1", "name": "Vocal take", "sample_rate": 48000, "channels": 1,
        "length_samples": 96000, "origin": "import",
    });
    let mut vocals = track("t9", "Vocals", "audio", json!([]), json!([]));
    vocals["audio_clips"] = json!([{
        "id": "a1", "sample_id": "s1", "start_ticks": 0, "offset_samples": 0,
        "slice_samples": 96000, "length_samples": 96000,
    }]);
    (sample, vocals)
}

#[tokio::test]
async fn audio_tracks_are_left_out_of_the_midi_file() {
    let (sample, loops) = audio_song_parts();
    let mut s = song(
        4,
        vec![
            track("t1", "Drums", "drums", json!([]), json!([])),
            loops,
            track("t3", "Bass", "bass", json!([]), json!([])),
        ],
    );
    s["samples"] = json!([sample]);
    let (status, _, bytes) = export(&s).await;
    assert_eq!(status, StatusCode::OK);
    let smf = Smf::parse(&bytes).unwrap();
    assert_eq!(smf.tracks.len(), 3);
    let channel_of = |index: usize| {
        smf.tracks[index].iter().find_map(|e| match e.kind {
            midly::TrackEventKind::Midi { channel, .. } => Some(channel.as_int()),
            _ => None,
        })
    };
    assert_eq!(channel_of(1), Some(9));
    assert_eq!(channel_of(2), Some(0));
}

#[tokio::test]
async fn an_audio_track_is_not_rejected_as_an_unknown_instrument() {
    let (sample, loops) = audio_song_parts();
    let mut s = song(4, vec![loops]);
    s["samples"] = json!([sample]);
    let (status, _, _) = export(&s).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_clip_naming_an_unknown_sample_names_the_track() {
    let (_, loops) = audio_song_parts();
    let (status, _, bytes) = export(&song(4, vec![loops])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let error = error_of(&bytes);
    assert_eq!(error["code"], "invalid_song");
    assert!(error["message"].as_str().unwrap().contains("\"Vocals\""));
}

#[tokio::test]
async fn pads_export_on_a_melodic_channel_with_no_program_change() {
    let sample = json!({
        "id": "s1", "name": "Kick", "sample_rate": 48000, "channels": 1,
        "length_samples": 48000, "origin": "import",
    });
    let mut pads = track(
        "t2",
        "Pads",
        "sampler-pads",
        json!([{"id": "l1", "name": "Hits", "measures": 1, "notes": [note("pad-1", 0), note("pad-3", 4)]}]),
        json!([{"id": "c1", "loop_id": "l1", "start_measure": 1, "measures": 1}]),
    );
    pads["sampler"] = json!({"pads": [
        {"row_id": "pad-1", "sample_id": "s1"},
        {"row_id": "pad-3", "sample_id": "s1"},
    ]});
    let mut s = song(
        1,
        vec![track("t1", "Drums", "drums", json!([]), json!([])), pads],
    );
    s["samples"] = json!([sample]);
    let (status, _, bytes) = export(&s).await;
    assert_eq!(status, StatusCode::OK);
    let smf = Smf::parse(&bytes).unwrap();
    assert_eq!(smf.tracks.len(), 3);

    let mut notes = Vec::new();
    for event in &smf.tracks[2] {
        if let midly::TrackEventKind::Midi { channel, message } = event.kind {
            assert_eq!(channel.as_int(), 0, "first melodic channel");
            match message {
                midly::MidiMessage::NoteOn { key, .. } => notes.push(key.as_int()),
                midly::MidiMessage::ProgramChange { .. } => panic!("unexpected program change"),
                _ => {}
            }
        }
    }
    assert_eq!(notes, vec![36, 38]);
}
